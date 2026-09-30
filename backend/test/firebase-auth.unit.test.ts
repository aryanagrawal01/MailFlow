import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createServer } from "node:http";
import express from "express";
import pino from "pino";
import { loadServerEnvironment } from "@mailflow/shared";
import { createAuthRouter } from "../src/auth/router.js";
import { createFirebaseTokenVerifier } from "../src/auth/firebase-provider.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";

const environment = loadServerEnvironment({
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  ELASTICSEARCH_URL: "http://localhost:9200",
  FRONTEND_ORIGIN: "http://localhost:5173",
  FIREBASE_PROJECT_ID: "mailflow-test-project",
});

test("Firebase Admin verifier rejects malformed tokens before trusting identity claims", async () => {
  const verifier = createFirebaseTokenVerifier(environment.FIREBASE_PROJECT_ID!);
  await assert.rejects(() => verifier.verifyIdToken("not-a-jwt"));
});

test("Firebase sign-in verifies identity before issuing an HttpOnly MailFlow session", async (t) => {
  let userCreated = 0;
  let sessionCreated = 0;
  const prisma = {
    user: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }: { data: { googleSubject: string; email: string; name: string; avatarUrl: string | null } }) => {
        userCreated += 1;
        return { id: "test-user-id", ...data };
      },
    },
    session: {
      create: async () => { sessionCreated += 1; return { id: "test-session-id" }; },
    },
  } as unknown as PrismaClient;
  const firebaseTokenVerifier = {
    async verifyIdToken(token: string) {
      if (token === "invalid") throw new Error("invalid token");
      return { uid: "firebase-test-uid", email: "Test@Example.test", name: "Test User", picture: null, emailVerified: token === "valid-id-token" || token === "firebase-email-password", signInProvider: token === "firebase-email-password" ? "password" : "google.com" };
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/auth", createAuthRouter({ environment, prisma, logger: pino({ enabled: false }), firebaseTokenVerifier }));
  const server = createServer(app).listen(0, "127.0.0.1");
  t.after(async () => { server.close(); await once(server, "close"); });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/api/auth/firebase`;

  const invalid = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: "invalid" }) });
  assert.equal(invalid.status, 401);
  const unverified = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: "valid-id-token-but-unverified" }) });
  assert.equal(unverified.status, 401);
  const firebaseEmailPassword = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: "firebase-email-password" }) });
  assert.equal(firebaseEmailPassword.status, 401);
  const wrongOrigin = await fetch(endpoint, { method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/json" }, body: JSON.stringify({ idToken: "valid-id-token" }) });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(userCreated, 0);
  const accepted = await fetch(endpoint, { method: "POST", headers: { origin: environment.FRONTEND_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ idToken: "valid-id-token" }) });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { authenticated: true });
  assert.match(accepted.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(accepted.headers.get("set-cookie") ?? "", /SameSite=Lax/);
  assert.equal(userCreated, 1);
  assert.equal(sessionCreated, 1);
});
