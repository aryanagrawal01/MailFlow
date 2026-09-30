import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Logger } from "pino";
import type { ServerEnvironment } from "@mailflow/shared";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createRequireAuth } from "./middleware.js";
import type { GoogleOAuthProvider, GoogleProfile } from "./google-provider.js";
import { hashPassword, verifyPassword } from "./password.js";
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
  firebaseTokenVerifier?: FirebaseTokenVerifier;
};

export type FirebaseIdentity = { uid: string; email: string; name: string; picture: string | null; emailVerified: boolean; signInProvider: string | null };
export type FirebaseTokenVerifier = { verifyIdToken(token: string): Promise<FirebaseIdentity> };

export function createAuthRouter(options: AuthRouterOptions) {
  const { environment, prisma, logger } = options;
  const router = Router();
  const requireAuth = createRequireAuth(prisma, environment);
  router.post("/register", async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (!isAllowedOrigin(request.get("origin"), environment.FRONTEND_ORIGIN, response)) return;
    const { name, username, email, contactNumber, password } = request.body ?? {};
    const normalizedName = typeof name === "string" ? name.trim() : "";
    const normalizedUsername = typeof username === "string" ? username.trim().toLowerCase() : "";
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    const normalizedContact = typeof contactNumber === "string" ? contactNumber.trim() : "";
    if (normalizedName.length < 2 || normalizedName.length > 100
      || !/^[a-z0-9._-]{3,32}$/.test(normalizedUsername)
      || normalizedEmail.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
      || normalizedContact.length > 32 || !/^\+?[0-9][0-9 ()-]{6,20}$/.test(normalizedContact)
      || typeof password !== "string" || password.length < 8 || password.length > 128) {
      response.status(400).json({ error: "Enter a valid name, username, email, contact number, and password of 8–128 characters." });
      return;
    }
    try {
      const duplicate = await prisma.user.findFirst({
        where: { OR: [{ username: normalizedUsername }, { email: { equals: normalizedEmail, mode: "insensitive" } }] },
        select: { id: true },
      });
      if (duplicate) {
        response.status(409).json({ error: "That username or email is already registered. Sign in or use different details." });
        return;
      }
      const passwordHash = await hashPassword(password);
      const user = await prisma.user.create({
        data: { name: normalizedName, username: normalizedUsername, email: normalizedEmail, contactNumber: normalizedContact, passwordHash },
        select: { id: true },
      });
      const { token, session } = await createApplicationSession(prisma, user.id, environment.SESSION_TTL_HOURS);
      setSessionCookie(response, environment, token);
      logger.info({ userId: user.id, sessionId: session.id, provider: "password" }, "user account created");
      response.status(201).json({ authenticated: true });
    } catch (error) {
      if (isPrismaUniqueConflict(error)) {
        response.status(409).json({ error: "That username or email is already registered. Sign in or use different details." });
        return;
      }
      next(error);
    }
  });

  router.post("/login", async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (!isAllowedOrigin(request.get("origin"), environment.FRONTEND_ORIGIN, response)) return;
    const identifier = typeof request.body?.identifier === "string" ? request.body.identifier.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!identifier || identifier.length > 320 || !password || password.length > 128) {
      response.status(400).json({ error: "Enter your username or email and password." });
      return;
    }
    try {
      const user = await prisma.user.findFirst({
        where: { OR: [{ username: identifier }, { email: { equals: identifier, mode: "insensitive" } }] },
        select: { id: true, passwordHash: true },
      });
      const valid = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : false;
      if (!user || !valid) {
        logger.warn({ provider: "password", outcome: "rejected" }, "password sign-in rejected");
        response.status(401).json({ error: "Username/email or password is incorrect." });
        return;
      }
      const { token, session } = await createApplicationSession(prisma, user.id, environment.SESSION_TTL_HOURS);
      setSessionCookie(response, environment, token);
      logger.info({ userId: user.id, sessionId: session.id, provider: "password" }, "user signed in");
      response.status(200).json({ authenticated: true });
    } catch (error) { next(error); }
  });

  router.post("/firebase", async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    const origin = request.get("origin");
    if (origin && origin !== environment.FRONTEND_ORIGIN) {
      response.status(403).json({ error: "Request origin is not allowed" });
      return;
    }
    if (!environment.FIREBASE_PROJECT_ID || !options.firebaseTokenVerifier) {
      response.status(503).json({ error: "Firebase sign-in is not configured" });
      return;
    }
    const token = request.body && typeof request.body.idToken === "string" ? request.body.idToken : "";
    if (!token || token.length > 12_000) {
      response.status(400).json({ error: "A valid Firebase ID token is required" });
      return;
    }
    let identity: FirebaseIdentity;
    try {
      identity = await options.firebaseTokenVerifier.verifyIdToken(token);
    } catch (error) {
      logger.warn({ provider: "firebase_google", errorName: error instanceof Error ? error.name : "UnknownError" }, "Firebase identity verification failed");
      response.status(401).json({ error: "Firebase sign-in could not be completed" });
      return;
    }
    if (identity.signInProvider !== "google.com" || !identity.emailVerified || !identity.email || !identity.uid) {
      response.status(401).json({ error: "A verified Google account is required" });
      return;
    }
    try {
      const email = identity.email.trim().toLowerCase();
      // Link a verified Firebase Google identity to an existing MailFlow account by email,
      // preserving ownership when migrating from the previous direct Google OAuth flow.
      const existing = await prisma.user.findUnique({ where: { googleSubject: `firebase:${identity.uid}` }, select: { id: true } })
        ?? await prisma.user.findFirst({ where: { email }, select: { id: true } });
      const user = existing
        ? await prisma.user.update({ where: { id: existing.id }, data: { googleSubject: `firebase:${identity.uid}`, email, name: identity.name || email, avatarUrl: identity.picture } , select: { id: true } })
        : await prisma.user.create({ data: { googleSubject: `firebase:${identity.uid}`, email, name: identity.name || email, avatarUrl: identity.picture }, select: { id: true } });
      const { token: sessionToken, session } = await createApplicationSession(prisma, user.id, environment.SESSION_TTL_HOURS);
      setSessionCookie(response, environment, sessionToken);
      logger.info({ userId: user.id, sessionId: session.id, provider: "firebase_google" }, "user signed in");
      response.status(200).json({ authenticated: true });
    } catch (error) { next(error); }
  });
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

function isAllowedOrigin(origin: string | undefined, allowedOrigin: string, response: import("express").Response): boolean {
  if (origin && origin !== allowedOrigin) {
    response.status(403).json({ error: "Request origin is not allowed" });
    return false;
  }
  return true;
}

function isPrismaUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
