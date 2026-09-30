import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { closeInfrastructureClients, createInfrastructureClients, loadServerEnvironment } from "@mailflow/shared";
import { createApplicationSession } from "../src/auth/session.js";
import { createApp } from "../src/app.js";
import { createPrismaClient } from "../src/db/client.js";
import { SlackApiError, type SlackApi, type SlackOAuthProvider } from "../src/slack/client.js";
import { notifySenderHourlyLimit } from "../src/slack/alerts.js";
import { decryptSlackToken, encryptSlackToken } from "../src/slack/token-crypto.js";

const suffix = randomUUID();
const encryptionKey = randomBytes(32).toString("base64url");
const environment = loadServerEnvironment({
  ...process.env,
  SLACK_CLIENT_ID: "test-slack-client",
  SLACK_CLIENT_SECRET: "test-slack-secret",
  SLACK_REDIRECT_URI: "http://localhost:4000/api/slack/oauth/callback",
  SLACK_OAUTH_STATE_SECRET: "slack-oauth-state-secret-is-long-enough-for-tests",
  SLACK_TOKEN_ENCRYPTION_KEY: encryptionKey,
});
const prisma = createPrismaClient(environment.DATABASE_URL);
const infrastructure = createInfrastructureClients(environment);
const logger = pino({ enabled: false });
let ownerId = "";
let otherId = "";
let ownerToken = "";
let otherToken = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let baseUrl = "";
const postedMessages: Array<{ channelId: string; text: string }> = [];
const oauth: SlackOAuthProvider = {
  authorizationUrl(state) { return `https://slack.test/oauth?state=${encodeURIComponent(state)}`; },
  async exchangeCode(code) {
    assert.equal(code, "valid-code");
    return { accessToken: `xoxb-${suffix}-realistic-test-token`, teamId: `T${suffix.slice(0, 8)}`, teamName: "Test workspace", authedUserId: "U12345678" };
  },
};
const api: SlackApi = {
  async listChannels(token) {
    assert.equal(token, `xoxb-${suffix}-realistic-test-token`);
    return [
      { id: "C12345678", name: "alerts", isPrivate: false, isMember: true },
      { id: "G12345678", name: "private-alerts", isPrivate: true, isMember: true },
    ];
  },
  async postMessage(token, channelId, text) {
    assert.equal(token, `xoxb-${suffix}-realistic-test-token`);
    postedMessages.push({ channelId, text });
    return `ts-${postedMessages.length}`;
  },
};

before(async () => {
  const owner = await prisma.user.create({ data: { googleSubject: `slack-owner-${suffix}`, email: `slack-owner-${suffix}@example.test`, name: "Slack owner" } });
  const other = await prisma.user.create({ data: { googleSubject: `slack-other-${suffix}`, email: `slack-other-${suffix}@example.test`, name: "Other" } });
  ownerId = owner.id; otherId = other.id;
  ownerToken = (await createApplicationSession(prisma, ownerId, 1)).token;
  otherToken = (await createApplicationSession(prisma, otherId, 1)).token;
  const app = createApp(logger, environment, infrastructure, { prisma, slackOAuthProvider: oauth, slackApi: api });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) { server.close(); await once(server, "close"); }
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId].filter(Boolean) } } });
  await Promise.allSettled([prisma.$disconnect(), closeInfrastructureClients(infrastructure)]);
});

test("Slack OAuth state, secure connection/channel ownership, reconnect, and one-alert-per-UTC-hour behavior", async () => {
  const cookie = (token: string) => `${environment.SESSION_COOKIE_NAME}=${token}`;
  const channelPreflight = await fetch(`${baseUrl}/api/slack/channel`, {
    method: "OPTIONS", headers: { origin: environment.FRONTEND_ORIGIN, "access-control-request-method": "PUT" },
  });
  assert.equal(channelPreflight.status, 204);
  assert.match(channelPreflight.headers.get("access-control-allow-methods") ?? "", /PUT.*DELETE/);
  const start = await fetch(`${baseUrl}/api/slack/oauth/start`, { headers: { cookie: cookie(ownerToken) }, redirect: "manual" });
  assert.equal(start.status, 302);
  const stateCookie = cookiePair(start, "mailflow_slack_oauth_state");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const wrongState = await fetch(`${baseUrl}/api/slack/oauth/callback?state=wrong&code=valid-code`, { headers: { cookie: `${cookie(ownerToken)}; ${stateCookie}` }, redirect: "manual" });
  assert.equal(wrongState.status, 400);
  assert.match((await wrongState.json() as { error: string }).error, /state validation/);
  const callback = await fetch(`${baseUrl}/api/slack/oauth/callback?state=${encodeURIComponent(state)}&code=valid-code`, { headers: { cookie: `${cookie(ownerToken)}; ${stateCookie}` }, redirect: "manual" });
  assert.equal(callback.status, 302);

  const connection = await prisma.slackConnection.findUniqueOrThrow({ where: { userId: ownerId } });
  assert.equal(connection.botTokenEncrypted.includes(`xoxb-${suffix}`), false);
  assert.equal(decryptSlackToken(connection.botTokenEncrypted, encryptionKey), `xoxb-${suffix}-realistic-test-token`);
  const connectionResponse = await fetch(`${baseUrl}/api/slack/connection`, { headers: { cookie: cookie(ownerToken) } });
  const connectionJson = await connectionResponse.text();
  assert.equal(connectionResponse.status, 200);
  assert.equal(connectionJson.includes("xoxb-"), false);
  const otherConnection = await fetch(`${baseUrl}/api/slack/connection`, { headers: { cookie: cookie(otherToken) } });
  assert.equal((await otherConnection.json() as { connected: boolean }).connected, false);

  const channels = await fetch(`${baseUrl}/api/slack/channels`, { headers: { cookie: cookie(ownerToken) } });
  assert.equal(channels.status, 200);
  assert.equal((await channels.json() as { channels: unknown[] }).channels.length, 2);
  const crossConnectionChannel = await fetch(`${baseUrl}/api/slack/channel`, {
    method: "PUT", headers: { cookie: cookie(otherToken), "content-type": "application/json" }, body: JSON.stringify({ channelId: "C12345678" }),
  });
  assert.equal(crossConnectionChannel.status, 404);
  const selected = await fetch(`${baseUrl}/api/slack/channel`, {
    method: "PUT", headers: { cookie: cookie(ownerToken), "content-type": "application/json" }, body: JSON.stringify({ channelId: "C12345678" }),
  });
  assert.equal(selected.status, 200);

  const hour = currentHour();
  const notifications = await Promise.all(Array.from({ length: 24 }, () => notifySenderHourlyLimit({
    prisma, userId: ownerId, hourWindowStart: hour, encryptionKey, logger, api,
  })));
  assert.equal(notifications.length, 24);
  assert.equal(postedMessages.length, 1, "unique user/hour alert permits only one Slack post across concurrent workers");
  assert.equal(await prisma.slackAlert.count({ where: { userId: ownerId, hourWindowStart: hour, status: "sent" } }), 1);
  await Promise.all(Array.from({ length: 5 }, () => notifySenderHourlyLimit({ prisma, userId: ownerId, hourWindowStart: hour, encryptionKey, logger, api })));
  assert.equal(postedMessages.length, 1, "subsequent deferred emails do not repeat the message");

  await prisma.slackConnection.deleteMany({ where: { userId: ownerId } });
  const noConnectionHour = hour;
  await assert.doesNotReject(notifySenderHourlyLimit({ prisma, userId: otherId, hourWindowStart: noConnectionHour, encryptionKey, logger, api }));
  assert.equal(await prisma.slackAlert.count({ where: { userId: otherId, hourWindowStart: noConnectionHour, status: "skipped" } }), 1);
  await prisma.slackConnection.create({ data: {
    userId: otherId, slackTeamId: `T${suffix.slice(0, 8)}`, slackTeamName: "Test workspace", slackUserId: "U12345678",
    botTokenEncrypted: encryptSlackToken(`xoxb-${suffix}-realistic-test-token`, encryptionKey), channelId: "", channelName: null,
  } });
  const laterSelected = await fetch(`${baseUrl}/api/slack/channel`, {
    method: "PUT", headers: { cookie: cookie(otherToken), "content-type": "application/json" }, body: JSON.stringify({ channelId: "C12345678" }),
  });
  assert.equal(laterSelected.status, 200);
  assert.equal(await prisma.slackAlert.count({ where: { userId: otherId, hourWindowStart: noConnectionHour, status: "sent" } }), 1);
  assert.equal(postedMessages.length, 2, "connecting Slack later sends the skipped alert once");

  await prisma.slackConnection.create({ data: {
    userId: ownerId, slackTeamId: `T${suffix.slice(0, 8)}`, slackTeamName: "Test workspace", slackUserId: "U12345678",
    botTokenEncrypted: encryptSlackToken(`xoxb-${suffix}-realistic-test-token`, encryptionKey), channelId: "C12345678", channelName: "alerts",
  } });
  const failedHour = new Date(hour.getTime() + 3_600_000);
  await assert.doesNotReject(notifySenderHourlyLimit({
    prisma, userId: ownerId, hourWindowStart: failedHour, encryptionKey, logger,
    api: { ...api, async postMessage() { throw new SlackApiError("invalid_auth"); } },
  }));
  const failedAlert = await prisma.slackAlert.findUniqueOrThrow({ where: { userId_hourWindowStart: { userId: ownerId, hourWindowStart: failedHour } } });
  assert.equal(failedAlert.status, "failed", "revoked tokens are recorded without throwing into delivery processing");

  const disconnected = await fetch(`${baseUrl}/api/slack/connection`, { method: "DELETE", headers: { cookie: cookie(ownerToken) } });
  assert.equal(disconnected.status, 204);
  assert.equal((await (await fetch(`${baseUrl}/api/slack/connection`, { headers: { cookie: cookie(ownerToken) } })).json() as { connected: boolean }).connected, false);
  const reconnectStart = await fetch(`${baseUrl}/api/slack/oauth/start`, { headers: { cookie: cookie(ownerToken) }, redirect: "manual" });
  const reconnectState = new URL(reconnectStart.headers.get("location")!).searchParams.get("state")!;
  const reconnectCookie = cookiePair(reconnectStart, "mailflow_slack_oauth_state");
  const reconnect = await fetch(`${baseUrl}/api/slack/oauth/callback?state=${encodeURIComponent(reconnectState)}&code=valid-code`, { headers: { cookie: `${cookie(ownerToken)}; ${reconnectCookie}` }, redirect: "manual" });
  assert.equal(reconnect.status, 302);
  assert.equal((await (await fetch(`${baseUrl}/api/slack/connection`, { headers: { cookie: cookie(ownerToken) } })).json() as { connected: boolean }).connected, true);
  const unauthenticated = await fetch(`${baseUrl}/api/slack/oauth/start`);
  assert.equal(unauthenticated.status, 401);
});

function cookiePair(response: Response, name: string): string {
  const cookie = response.headers.getSetCookie().find((item) => item.startsWith(`${name}=`));
  assert.ok(cookie, `${name} cookie is set`);
  return cookie.split(";", 1)[0]!;
}

function currentHour(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
}
