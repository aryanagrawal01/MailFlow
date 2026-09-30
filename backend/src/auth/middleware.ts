import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { findActiveSession, readCookie, sessionTokenHash, type AuthenticatedSession } from "./session.js";
import type { ServerEnvironment } from "@mailflow/shared";

declare global {
  namespace Express {
    interface Locals {
      auth?: AuthenticatedSession;
    }
  }
}

export function createRequireAuth(prisma: PrismaClient, environment: ServerEnvironment) {
  return async function requireAuth(request: Request, response: Response, next: NextFunction): Promise<void> {
    try {
      const token = readCookie(request, environment.SESSION_COOKIE_NAME);
      if (!token) {
        response.status(401).json({ error: "Authentication required" });
        return;
      }

      const activeSession = await findActiveSession(prisma, token);
      if (!activeSession) {
        response.status(401).json({ error: "Authentication required" });
        return;
      }

      const touched = await prisma.session.updateMany({
        where: {
          id: activeSession.sessionId,
          tokenHash: sessionTokenHash(token),
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { lastUsedAt: new Date() },
      });
      if (touched.count !== 1) {
        response.status(401).json({ error: "Authentication required" });
        return;
      }

      response.locals.auth = activeSession;
      next();
    } catch (error) {
      next(error);
    }
  };
}
