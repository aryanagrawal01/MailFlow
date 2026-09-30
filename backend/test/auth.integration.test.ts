import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { closeInfrastructureClients, createInfrastructureClients, loadServerEnvironment } from "@mailflow/shared";
import { createApp } from "../src/app.js";
import type { GoogleOAuthProvider } from "../src/auth/google-provider.js";
import { createApplicationSession, setOAuthStateCookie, setSessionCookie, sessionTokenHash, verifyOAuthStateCookie } from "../src/auth/session.js";
import { createPrismaClient } from "../src/db/client.js";

const suffix = randomUUID();
const environment = loadServerEnvironment({
  ...process.env,
  GOOGLE_CLIENT_ID: "mailflow-test-client-id",
  GOOGLE_CLIENT_SECRET: "mailflow-test-client-secret",
  GOOGLE_REDIRECT_URI: "http://localhost:4000/api/auth/google/callback",
  GOOGLE_OAUTH_STATE_SECRET: "test-oauth-state-secret-which-is-long-enough",
  FRONTEND_ORIGIN: "http://localhost:5173",
});
const prisma = createPrismaClient(environment.DATABASE_URL);
const infrastructure = createInfrastructureClients(environment);
let lastAuthorization: { state: string; nonce: string; codeChallenge: string } | undefined;
const googleOAuthProvider: GoogleOAuthProvider = {
  authorizationUrl(input) {
    lastAuthorization = input;
    return "https://accounts.google.test/authorize";
  },
  async verifyAuthorizationCode(code, codeVerifier) {
    assert.equal(code, "valid-code");
    assert.ok(codeVerifier.length >= 43);
    assert.ok(lastAuthorization);
    return {
      sub: `auth-test-${suffix}`,
      email: `phase3-${suffix}@example.test`,
      name: "Phase 3 Test User",
      picture: "https://example.test/avatar.png",
      nonce: lastAuthorization.nonce,
    };
  },
};
const app = createApp(pino({ enabled: false }), environment, infrastructure, { prisma, googleOAuthProvider });
let server: ReturnType<typeof app.listen>;
let baseUrl = "";
let ownerId = "";

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  await prisma.user.deleteMany({
    where: { OR: [{ id: ownerId || "00000000-0000-0000-0000-000000000000" }, { googleSubject: `auth-test-${suffix}` }] },
  });
  await prisma.$disconnect();
  await closeInfrastructureClients(infrastructure);
});

test("Google OAuth state, protected routes, /me, logout, expiry, and revocation", async () => {
  const unauthenticatedApi = await fetch(`${baseUrl}/api/private`);
  assert.equal(unauthenticatedApi.status, 401);
  const unauthenticatedQueueBoard = await fetch(`${baseUrl}/admin/queues`);
  assert.equal(unauthenticatedQueueBoard.status, 401);
  const corsPreflight = await fetch(`${baseUrl}/api/auth/me`, {
    method: "OPTIONS",
    headers: { origin: environment.FRONTEND_ORIGIN, "access-control-request-method": "GET" },
  });
  assert.equal(corsPreflight.status, 204);
  assert.equal(corsPreflight.headers.get("access-control-allow-credentials"), "true");

  const invalidStateStart = await fetch(`${baseUrl}/api/auth/google`, { redirect: "manual" });
  assert.equal(invalidStateStart.status, 302);
  const invalidStateCookie = cookiePair(invalidStateStart, "mailflow_oauth_state");
  assert.ok(lastAuthorization);
  const mismatchedState = await fetch(
    `${baseUrl}/api/auth/google/callback?state=wrong-state&code=valid-code`,
    { headers: { cookie: invalidStateCookie } },
  );
  assert.equal(mismatchedState.status, 400);
  assert.match((await mismatchedState.json() as { error: string }).error, /state validation/);

  const loginStart = await fetch(`${baseUrl}/api/auth/google`, { redirect: "manual" });
  assert.equal(loginStart.status, 302);
  const stateCookie = cookiePair(loginStart, "mailflow_oauth_state");
  assert.ok(lastAuthorization);
  assert.equal(
    verifyOAuthStateCookie(environment.GOOGLE_OAUTH_STATE_SECRET!, decodeURIComponent(stateCookie.split("=", 2)[1]!))?.state,
    lastAuthorization.state,
  );
  const callback = await fetch(
    `${baseUrl}/api/auth/google/callback?state=${encodeURIComponent(lastAuthorization.state)}&code=valid-code`,
    { headers: { cookie: stateCookie }, redirect: "manual" },
  );
  assert.equal(callback.status, 302, await callback.clone().text());
  assert.equal(callback.headers.get("location"), environment.FRONTEND_ORIGIN);
  const sessionCookie = cookiePair(callback, environment.SESSION_COOKIE_NAME);

  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: sessionCookie } });
  assert.equal(me.status, 200);
  const currentUser = (await me.json() as { user: { id: string; email: string; name: string; avatarUrl: string | null } }).user;
  assert.equal(currentUser.email, `phase3-${suffix}@example.test`);
  assert.equal(currentUser.name, "Phase 3 Test User");
  ownerId = currentUser.id;
  assert.equal((await fetch(`${baseUrl}/api/private`, { headers: { cookie: sessionCookie } })).status, 404);
  assert.equal((await fetch(`${baseUrl}/admin/queues`, { headers: { cookie: sessionCookie } })).status, 404);

  const cookieToken = sessionCookie.slice(sessionCookie.indexOf("=") + 1);
  const storedSession = await prisma.session.findUnique({ where: { tokenHash: sessionTokenHash(decodeURIComponent(cookieToken)) } });
  assert.ok(storedSession);
  assert.ok(storedSession.lastUsedAt);
  await prisma.session.update({ where: { id: storedSession.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
  const expiredMe = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: sessionCookie } });
  assert.equal(expiredMe.status, 401);

  const freshSession = await createApplicationSession(prisma, ownerId, environment.SESSION_TTL_HOURS);
  const logoutCookie = `${environment.SESSION_COOKIE_NAME}=${encodeURIComponent(freshSession.token)}`;
  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { cookie: logoutCookie } });
  assert.equal(logout.status, 204);
  const revokedSession = await prisma.session.findUnique({ where: { id: freshSession.session.id } });
  assert.ok(revokedSession?.revokedAt);
  const revokedMe = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: logoutCookie } });
  assert.equal(revokedMe.status, 401);
});

test("production session and OAuth state cookies are Secure, HttpOnly, and SameSite=Lax", () => {
  const headers: string[] = [];
  const response = { append: (_name: string, value: string) => { headers.push(value); } } as never;
  const production = { ...environment, NODE_ENV: "production" as const };
  setSessionCookie(response, production, "opaque-test-session");
  setOAuthStateCookie(response, production, "encrypted-test-state");
  assert.equal(headers.length, 2);
  for (const header of headers) {
    assert.match(header, /; Secure/);
    assert.match(header, /; HttpOnly/);
    assert.match(header, /; SameSite=Lax/);
  }
  assert.match(headers[1]!, /Path=\/api\/auth\/google\/callback/);
});

function cookiePair(response: Response, name: string): string {
  const line = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  assert.ok(line, `Expected ${name} cookie`);
  return line.split(";", 1)[0]!;
}
