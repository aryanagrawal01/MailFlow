import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { ServerEnvironment } from "@mailflow/shared";
import type { PrismaClient } from "../generated/prisma/client.js";

export const SESSION_COOKIE_PATH = "/";
export const OAUTH_STATE_COOKIE_NAME = "mailflow_oauth_state";
export const OAUTH_STATE_COOKIE_PATH = "/api/auth/google/callback";
export const OAUTH_STATE_TTL_SECONDS = 600;

export type AuthenticatedSession = {
  userId: string;
  sessionId: string;
  user: { id: string; email: string; name: string; avatarUrl: string | null };
};

export function sessionTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createApplicationSession(prisma: PrismaClient, userId: string, ttlHours: number) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  const session = await prisma.session.create({
    data: { userId, tokenHash: sessionTokenHash(token), expiresAt },
  });
  return { token, session };
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function setSessionCookie(response: Response, environment: ServerEnvironment, token: string): void {
  const maxAge = environment.SESSION_TTL_HOURS * 60 * 60;
  const cookie = [
    `${environment.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${SESSION_COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(environment.NODE_ENV === "production" ? ["Secure"] : []),
  ];
  response.append("Set-Cookie", cookie.join("; "));
}

export function clearSessionCookie(response: Response, environment: ServerEnvironment): void {
  const cookie = [
    `${environment.SESSION_COOKIE_NAME}=`,
    `Path=${SESSION_COOKIE_PATH}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(environment.NODE_ENV === "production" ? ["Secure"] : []),
  ];
  response.append("Set-Cookie", cookie.join("; "));
}

export function createOAuthStateCookie(secret: string, state: string, nonce: string, codeVerifier: string): string {
  const cleartext = Buffer.from(JSON.stringify({
    state,
    nonce,
    codeVerifier,
    expiresAt: Date.now() + OAUTH_STATE_TTL_SECONDS * 1000,
  }));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function verifyOAuthStateCookie(secret: string, cookie: string): {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
} | null {
  try {
    const encrypted = Buffer.from(cookie, "base64url");
    if (encrypted.length < 29) return null;
    const iv = encrypted.subarray(0, 12);
    const authTag = encrypted.subarray(12, 28);
    const ciphertext = encrypted.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
    decipher.setAuthTag(authTag);
    const cleartext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const decoded: unknown = JSON.parse(cleartext.toString("utf8"));
    if (!isOAuthStatePayload(decoded) || decoded.expiresAt <= Date.now()) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function setOAuthStateCookie(response: Response, environment: ServerEnvironment, value: string): void {
  const cookie = [
    `${OAUTH_STATE_COOKIE_NAME}=${encodeURIComponent(value)}`,
    `Path=${OAUTH_STATE_COOKIE_PATH}`,
    `Max-Age=${OAUTH_STATE_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(environment.NODE_ENV === "production" ? ["Secure"] : []),
  ];
  response.append("Set-Cookie", cookie.join("; "));
}

export function clearOAuthStateCookie(response: Response, environment: ServerEnvironment): void {
  const cookie = [
    `${OAUTH_STATE_COOKIE_NAME}=`,
    `Path=${OAUTH_STATE_COOKIE_PATH}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(environment.NODE_ENV === "production" ? ["Secure"] : []),
  ];
  response.append("Set-Cookie", cookie.join("; "));
}

export async function findActiveSession(
  prisma: PrismaClient,
  token: string,
  now = new Date(),
): Promise<AuthenticatedSession | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: sessionTokenHash(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt <= now) return null;
  return {
    userId: session.userId,
    sessionId: session.id,
    user: { id: session.user.id, email: session.user.email, name: session.user.name, avatarUrl: session.user.avatarUrl },
  };
}

function isOAuthStatePayload(value: unknown): value is {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.state === "string"
    && typeof candidate.nonce === "string"
    && typeof candidate.codeVerifier === "string"
    && typeof candidate.expiresAt === "number";
}
