import express from "express";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import type { ServerEnvironment } from "@mailflow/shared";
import { checkReadiness } from "@mailflow/shared";
import type { createInfrastructureClients } from "@mailflow/shared";
import type { PrismaClient } from "./generated/prisma/client.js";
import type { GoogleOAuthProvider } from "./auth/google-provider.js";
import type { FirebaseTokenVerifier } from "./auth/router.js";
import { createRequireAuth } from "./auth/middleware.js";
import { createAuthRouter } from "./auth/router.js";
import type { DeliveryQueueHandoff } from "@mailflow/shared";
import { createCampaignRouter, createDeliveryListRouter } from "./campaigns/router.js";
import type { Client } from "@elastic/elasticsearch";
import type { DeliverySearchIndexer } from "./elasticsearch/indexer.js";
import { createDeliverySearchRouter } from "./elasticsearch/search-router.js";
import type { SlackApi, SlackOAuthProvider } from "./slack/client.js";
import { createSlackRouter } from "./slack/router.js";
import type { Queue } from "bullmq";
import { DELIVERY_JOB_NAME, type DeliveryJobData } from "@mailflow/shared";
import { createQueueDashboard } from "./queues/dashboard.js";

type InfrastructureClients = ReturnType<typeof createInfrastructureClients>;
type AppAuthDependencies = {
  prisma: PrismaClient;
  googleOAuthProvider?: GoogleOAuthProvider;
  firebaseTokenVerifier?: FirebaseTokenVerifier;
  handoff?: Pick<DeliveryQueueHandoff, "reconcile">;
  searchClient?: Client;
  searchIndexer?: DeliverySearchIndexer;
  slackOAuthProvider?: SlackOAuthProvider;
  slackApi?: SlackApi;
  deliveryQueue?: Queue<DeliveryJobData, void, typeof DELIVERY_JOB_NAME>;
};

export function createApp(
  logger: Logger,
  environment: ServerEnvironment,
  clients: InfrastructureClients,
  authDependencies?: AppAuthDependencies,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(pinoHttp({
    logger,
    // OAuth authorization codes and state values arrive on this callback URL.
    autoLogging: {
      ignore: (request) => {
        const path = request.url ?? "";
        return path.startsWith("/api/auth/google/callback") || path.startsWith("/api/slack/oauth/callback");
      },
    },
  }));

  app.use((request, response, next) => {
    const origin = request.get("origin");
    if (origin) response.vary("Origin");
    if (origin === environment.FRONTEND_ORIGIN) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (request.method === "OPTIONS") {
      response.status(origin === environment.FRONTEND_ORIGIN ? 204 : 403).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok", service: "mailflow-api" });
  });

  app.get("/ready", async (_request, response) => {
    const readiness = await checkReadiness(environment, clients, logger);
    response.status(readiness.status === "ready" ? 200 : 503).json(readiness);
  });

  if (authDependencies) {
    const requireAuth = createRequireAuth(authDependencies.prisma, environment);
    app.use("/api/auth", createAuthRouter({ ...authDependencies, environment, logger }));
    app.use("/api", (request, response, next) => {
      if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        next();
        return;
      }
      const origin = request.get("origin");
      if (origin && origin !== environment.FRONTEND_ORIGIN) {
        response.status(403).json({ error: "Request origin is not allowed" });
        return;
      }
      next();
    });
    // All application API and the reserved queue/admin path require a valid DB session.
    app.use("/api", requireAuth);
    app.use("/api/slack", createSlackRouter({
      environment,
      prisma: authDependencies.prisma,
      logger,
      ...(authDependencies.slackOAuthProvider ? { oauthProvider: authDependencies.slackOAuthProvider } : {}),
      ...(authDependencies.slackApi ? { api: authDependencies.slackApi } : {}),
    }));
    app.use("/admin/queues", requireAuth);
    if (authDependencies.deliveryQueue) {
      app.use("/admin/queues", createQueueDashboard(authDependencies.deliveryQueue));
    }
    if (authDependencies.handoff) {
      if (authDependencies.searchClient && authDependencies.searchIndexer) {
        app.use("/api/deliveries/search", createDeliverySearchRouter(authDependencies.searchClient, authDependencies.searchIndexer));
      }
      app.use("/api/campaigns", createCampaignRouter({
        environment,
        prisma: authDependencies.prisma,
        handoff: authDependencies.handoff,
        logger,
        ...(authDependencies.searchIndexer ? { searchIndexer: authDependencies.searchIndexer } : {}),
      }));
      app.use("/api/deliveries", createDeliveryListRouter(authDependencies.prisma));
    }
  }

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const candidate = error as { name?: unknown; code?: unknown; status?: unknown } | null;
    logger.error({
      errorName: typeof candidate?.name === "string" ? candidate.name : "UnknownError",
      ...(typeof candidate?.code === "string" ? { errorCode: candidate.code.slice(0, 80) } : {}),
      ...(typeof candidate?.status === "number" ? { errorStatus: candidate.status } : {}),
    }, "unhandled API error");
    response.status(500).json({ error: "Internal server error" });
  });

  return app;
}
