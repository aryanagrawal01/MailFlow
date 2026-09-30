import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Logger } from "pino";
import type { ServerEnvironment } from "@mailflow/shared";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createRequireAuth } from "../auth/middleware.js";
import { readCookie } from "../auth/session.js";
import { flushSkippedSenderAlerts } from "./alerts.js";
import { slackApi, SlackApiError, type SlackApi, type SlackOAuthProvider } from "./client.js";
import { decryptSlackToken, encryptSlackToken } from "./token-crypto.js";

const STATE_COOKIE = "mailflow_slack_oauth_state";
const STATE_COOKIE_PATH = "/api/slack/oauth/callback";
const STATE_TTL_MS = 10 * 60 * 1_000;

export function createSlackRouter(options: {
  environment: ServerEnvironment;
  prisma: PrismaClient;
  logger: Logger;
  oauthProvider?: SlackOAuthProvider;
  api?: SlackApi;
}) {
  const { environment, prisma, logger } = options;
  const api = options.api ?? slackApi;
  const router = Router();
  const requireAuth = createRequireAuth(prisma, environment);
  const ready = Boolean(options.oauthProvider && environment.SLACK_OAUTH_STATE_SECRET && environment.SLACK_TOKEN_ENCRYPTION_KEY);

  router.get("/oauth/start", requireAuth, (request, response) => {
    const userId = response.locals.auth?.userId;
    if (!userId) { response.status(401).json({ error: "Authentication required" }); return; }
    if (!ready || !options.oauthProvider || !environment.SLACK_OAUTH_STATE_SECRET) {
      response.status(503).json({ error: "Slack OAuth is not configured" });
      return;
    }
    const state = randomBytes(32).toString("base64url");
    const value = signState({ state, userId, expiresAt: Date.now() + STATE_TTL_MS }, environment.SLACK_OAUTH_STATE_SECRET);
    setStateCookie(response, environment, value);
    response.setHeader("Cache-Control", "no-store");
    response.redirect(302, options.oauthProvider.authorizationUrl(state));
  });

  router.get("/oauth/callback", requireAuth, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    clearStateCookie(response, environment);
    const userId = response.locals.auth?.userId;
    const state = request.query.state;
    const code = request.query.code;
    const providerError = request.query.error;
    if (typeof providerError === "string") { response.status(400).json({ error: "Slack authorization was declined" }); return; }
    if (!userId || typeof state !== "string" || typeof code !== "string" || !code || !environment.SLACK_OAUTH_STATE_SECRET) {
      logger.warn({ userId, failure: "invalid_callback_parameters" }, "Slack OAuth callback rejected");
      response.status(400).json({ error: "Invalid Slack OAuth callback" });
      return;
    }
    const payload = verifyState(readCookie(request, STATE_COOKIE), environment.SLACK_OAUTH_STATE_SECRET);
    if (!payload || payload.userId !== userId || !safeEqual(payload.state, state)) {
      logger.warn({ userId, failure: "state_validation_failed" }, "Slack OAuth state validation failed");
      response.status(400).json({ error: "Slack OAuth state validation failed" });
      return;
    }
    if (!ready || !options.oauthProvider || !environment.SLACK_TOKEN_ENCRYPTION_KEY) {
      response.status(503).json({ error: "Slack OAuth is not configured" });
      return;
    }
    try {
      const install = await options.oauthProvider.exchangeCode(code);
      const botTokenEncrypted = encryptSlackToken(install.accessToken, environment.SLACK_TOKEN_ENCRYPTION_KEY);
      await prisma.slackConnection.upsert({
        where: { userId },
        create: {
          userId, slackTeamId: install.teamId, slackTeamName: install.teamName,
          slackUserId: install.authedUserId, botTokenEncrypted, channelId: "", channelName: null,
        },
        update: {
          slackTeamId: install.teamId, slackTeamName: install.teamName,
          slackUserId: install.authedUserId, botTokenEncrypted, channelId: "", channelName: null,
          connectedAt: new Date(), disconnectedAt: null,
        },
      });
      logger.info({ userId, slackTeamId: install.teamId }, "Slack workspace connected");
      response.redirect(302, `${environment.FRONTEND_ORIGIN}/?slack=connected`);
    } catch (error) {
      logger.warn({ userId, errorName: error instanceof Error ? error.name : "UnknownError" }, "Slack OAuth exchange failed");
      response.status(502).json({ error: "Slack connection could not be completed" });
    }
  });

  router.get("/connection", requireAuth, async (request, response) => {
    const userId = response.locals.auth?.userId;
    if (!userId) { response.status(401).json({ error: "Authentication required" }); return; }
    const connection = await prisma.slackConnection.findFirst({ where: { userId, disconnectedAt: null } });
    response.json(connection ? {
      connected: true,
      team: { id: connection.slackTeamId, name: connection.slackTeamName },
      channel: connection.channelId ? { id: connection.channelId, name: connection.channelName } : null,
      connectedAt: connection.connectedAt,
    } : { connected: false, team: null, channel: null, connectedAt: null });
  });

  router.get("/channels", requireAuth, async (request, response) => {
    const userId = response.locals.auth?.userId;
    if (!userId) { response.status(401).json({ error: "Authentication required" }); return; }
    if (!environment.SLACK_TOKEN_ENCRYPTION_KEY) { response.status(503).json({ error: "Slack is not configured" }); return; }
    const connection = await prisma.slackConnection.findFirst({ where: { userId, disconnectedAt: null } });
    if (!connection) { response.status(404).json({ error: "Slack is not connected" }); return; }
    try {
      const token = decryptToken(connection.botTokenEncrypted, environment.SLACK_TOKEN_ENCRYPTION_KEY);
      response.json({ channels: await api.listChannels(token) });
    } catch (error) {
      logger.warn({ userId, errorCode: slackErrorCode(error) }, "Slack channels could not be loaded");
      response.status(502).json({ error: "Slack channels are temporarily unavailable or the connection needs reconnecting" });
    }
  });

  router.put("/channel", requireAuth, async (request, response) => {
    const userId = response.locals.auth?.userId;
    if (!userId) { response.status(401).json({ error: "Authentication required" }); return; }
    const parsed = z.object({ channelId: z.string().regex(/^[A-Z0-9]{8,64}$/) }).safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: "Invalid Slack channel ID" }); return; }
    if (!environment.SLACK_TOKEN_ENCRYPTION_KEY) { response.status(503).json({ error: "Slack is not configured" }); return; }
    const connection = await prisma.slackConnection.findFirst({ where: { userId, disconnectedAt: null } });
    if (!connection) { response.status(404).json({ error: "Slack is not connected" }); return; }
    try {
      const token = decryptToken(connection.botTokenEncrypted, environment.SLACK_TOKEN_ENCRYPTION_KEY);
      const channels = await api.listChannels(token);
      const selected = channels.find((channel) => channel.id === parsed.data.channelId);
      if (!selected) { response.status(400).json({ error: "Channel is unavailable to this Slack app" }); return; }
      const saved = await prisma.slackConnection.updateMany({
        where: { id: connection.id, userId, disconnectedAt: null },
        data: { channelId: selected.id, channelName: selected.name },
      });
      if (!saved.count) { response.status(409).json({ error: "Slack connection changed; reconnect and try again" }); return; }
      await flushSkippedSenderAlerts({ prisma, userId, encryptionKey: environment.SLACK_TOKEN_ENCRYPTION_KEY, logger, api });
      response.json({ channel: { id: selected.id, name: selected.name }, team: { id: connection.slackTeamId, name: connection.slackTeamName } });
    } catch (error) {
      logger.warn({ userId, errorCode: slackErrorCode(error) }, "Slack channel selection failed");
      response.status(502).json({ error: "Slack channel selection is temporarily unavailable" });
    }
  });

  router.delete("/connection", requireAuth, async (request, response) => {
    const userId = response.locals.auth?.userId;
    if (!userId) { response.status(401).json({ error: "Authentication required" }); return; }
    await prisma.slackConnection.deleteMany({ where: { userId } });
    response.status(204).end();
  });

  return router;
}

function signState(payload: { state: string; userId: string; expiresAt: number }, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyState(value: string | null, secret: string): { state: string; userId: string; expiresAt: number } | null {
  try {
    if (!value) return null;
    const [encoded, signature] = value.split(".");
    if (!encoded || !signature) return null;
    const expected = createHmac("sha256", secret).update(encoded).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    const candidate = payload as { state?: unknown; userId?: unknown; expiresAt?: unknown };
    if (typeof candidate.state !== "string" || typeof candidate.userId !== "string" || typeof candidate.expiresAt !== "number" || candidate.expiresAt <= Date.now()) return null;
    return candidate as { state: string; userId: string; expiresAt: number };
  } catch { return null; }
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left); const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function setStateCookie(response: import("express").Response, environment: ServerEnvironment, value: string): void {
  response.append("Set-Cookie", [
    `${STATE_COOKIE}=${encodeURIComponent(value)}`, `Path=${STATE_COOKIE_PATH}`, `Max-Age=${STATE_TTL_MS / 1_000}`,
    "HttpOnly", "SameSite=Lax", ...(environment.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; "));
}

function clearStateCookie(response: import("express").Response, environment: ServerEnvironment): void {
  response.append("Set-Cookie", [
    `${STATE_COOKIE}=`, `Path=${STATE_COOKIE_PATH}`, "Max-Age=0", "HttpOnly", "SameSite=Lax",
    ...(environment.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; "));
}

function decryptToken(encrypted: string, key: string): string {
  // Isolated wrapper keeps all route errors generic while crypto errors stay out of responses.
  return decryptSlackToken(encrypted, key);
}

function slackErrorCode(error: unknown): string {
  return error instanceof SlackApiError ? error.slackCode.slice(0, 100) : "SLACK_REQUEST_FAILED";
}
