import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Logger } from "pino";
import type { ServerEnvironment } from "@mailflow/shared";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createRequireAuth } from "./middleware.js";
import type { GoogleOAuthProvider, GoogleProfile } from "./google-provider.js";
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  createApplicationSession,
  createOAuthStateCookie,
  findActiveSession,
  OAUTH_STATE_COOKIE_NAME,
  readCookie,
  setOAuthStateCookie,
  setSessionCookie,
  sessionTokenHash,
  verifyOAuthStateCookie,
} from "./session.js";

export type AuthRouterOptions = {
  environment: ServerEnvironment;
  prisma: PrismaClient;
  logger: Logger;
  googleOAuthProvider?: GoogleOAuthProvider;
};

export function createAuthRouter(options: AuthRouterOptions) {
  const { environment, prisma, logger } = options;
  const router = Router();
  const requireAuth = createRequireAuth(prisma, environment);
  const googleOAuthReady = Boolean(
    environment.GOOGLE_CLIENT_ID
      && environment.GOOGLE_CLIENT_SECRET
      && environment.GOOGLE_REDIRECT_URI
      && environment.GOOGLE_OAUTH_STATE_SECRET
      && options.googleOAuthProvider,
  );

  router.get(["/google", "/google/start"], (_request, response) => {
    if (!googleOAuthReady || !environment.GOOGLE_OAUTH_STATE_SECRET || !options.googleOAuthProvider) {
      response.status(503).json({ error: "Google sign-in is not configured" });
      return;
    }

    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const signedState = createOAuthStateCookie(environment.GOOGLE_OAUTH_STATE_SECRET, state, nonce, codeVerifier);
    setOAuthStateCookie(response, environment, signedState);
    response.setHeader("Cache-Control", "no-store");
    response.redirect(302, options.googleOAuthProvider.authorizationUrl({ state, nonce, codeChallenge }));
  });

  router.get("/google/callback", async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    const stateCookie = readCookie(request, OAUTH_STATE_COOKIE_NAME);
    clearOAuthStateCookie(response, environment);

    const queryState = request.query.state;
    const code = request.query.code;
    if (typeof queryState !== "string" || typeof code !== "string" || !code) {
      logger.warn({ failure: "invalid_callback_parameters" }, "Google OAuth callback rejected");
      response.status(400).json({ error: "Invalid Google OAuth callback" });
      return;
    }

    const statePayload = stateCookie && environment.GOOGLE_OAUTH_STATE_SECRET
      ? verifyOAuthStateCookie(environment.GOOGLE_OAUTH_STATE_SECRET, stateCookie)
      : null;
    if (!statePayload || !constantTimeStringEqual(statePayload.state, queryState)) {
      logger.warn({ failure: "state_validation_failed" }, "Google OAuth state validation failed");
      response.status(400).json({ error: "OAuth state validation failed" });
      return;
    }
    if (!options.googleOAuthProvider) {
      response.status(503).json({ error: "Google sign-in is not configured" });
      return;
    }

    let profile: GoogleProfile;
    try {
      profile = await options.googleOAuthProvider.verifyAuthorizationCode(code, statePayload.codeVerifier);
    } catch (error) {
      logger.warn({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Google identity verification failed");
      response.status(401).json({ error: "Google sign-in could not be completed" });
      return;
    }

    if (!constantTimeStringEqual(profile.nonce, statePayload.nonce)) {
      response.status(400).json({ error: "Google OAuth nonce validation failed" });
      return;
    }

    const user = await prisma.user.upsert({
      where: { googleSubject: profile.sub },
      create: {
        googleSubject: profile.sub,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.picture,
      },
      update: {
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.picture,
      },
      select: { id: true },
    });
    const { token, session } = await createApplicationSession(prisma, user.id, environment.SESSION_TTL_HOURS);
    setSessionCookie(response, environment, token);
    logger.info({ userId: user.id, sessionId: session.id }, "user signed in with Google");
    response.redirect(302, environment.FRONTEND_ORIGIN);
  });

  router.get("/me", requireAuth, (_request, response) => {
    const auth = response.locals.auth;
    if (!auth) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }
    response.json({ user: auth.user });
  });

  router.post("/logout", async (request, response, next) => {
    try {
      const origin = request.get("origin");
      if (origin && origin !== environment.FRONTEND_ORIGIN) {
        response.status(403).json({ error: "Request origin is not allowed" });
        return;
      }
      const token = readCookie(request, environment.SESSION_COOKIE_NAME);
      if (token) {
        const active = await findActiveSession(prisma, token);
        if (active) {
          await prisma.session.updateMany({
            where: { id: active.sessionId, tokenHash: sessionTokenHash(token), revokedAt: null },
            data: { revokedAt: new Date() },
          });
          logger.info({ userId: active.userId, sessionId: active.sessionId }, "application session revoked");
        }
      }
      clearSessionCookie(response, environment);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
