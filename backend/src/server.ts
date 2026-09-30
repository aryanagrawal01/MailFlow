import "dotenv/config";
import { closeInfrastructureClients, createLogger, createInfrastructureClients, loadServerEnvironment } from "@mailflow/shared";
import { createApp } from "./app.js";
import { createPrismaClient } from "./db/client.js";
import { createGoogleOAuthProvider } from "./auth/google-provider.js";
import { createDeliveryQueue, DeliveryQueueHandoff } from "@mailflow/shared";
import { createOutboxHandoffStore } from "./queues/outbox-store.js";
import { createElasticsearchClient } from "./elasticsearch/client.js";
import { DeliverySearchIndexer } from "./elasticsearch/indexer.js";
import { createSlackOAuthProvider } from "./slack/client.js";

const environment = loadServerEnvironment();
const logger = createLogger("mailflow-api");
const clients = createInfrastructureClients(environment);
const prisma = createPrismaClient(environment.DATABASE_URL);
const searchClient = createElasticsearchClient(environment.ELASTICSEARCH_URL, environment.ELASTICSEARCH_API_KEY);
const searchIndexer = new DeliverySearchIndexer(prisma, searchClient, logger);
const deliveryQueue = createDeliveryQueue(environment.REDIS_URL, {
  attempts: environment.DELIVERY_MAX_ATTEMPTS,
  retryDelayMs: Math.max(1_000, environment.MIN_DELAY_MS),
});
const queueHandoff = new DeliveryQueueHandoff(deliveryQueue, createOutboxHandoffStore(prisma), logger);
const googleOAuthProvider = environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET && environment.GOOGLE_REDIRECT_URI
  ? createGoogleOAuthProvider({
      clientId: environment.GOOGLE_CLIENT_ID,
      clientSecret: environment.GOOGLE_CLIENT_SECRET,
      redirectUri: environment.GOOGLE_REDIRECT_URI,
    })
  : undefined;
const slackOAuthProvider = environment.SLACK_CLIENT_ID && environment.SLACK_CLIENT_SECRET && environment.SLACK_REDIRECT_URI
  ? createSlackOAuthProvider({
      clientId: environment.SLACK_CLIENT_ID,
      clientSecret: environment.SLACK_CLIENT_SECRET,
      redirectUri: environment.SLACK_REDIRECT_URI,
    })
  : undefined;
clients.postgres.on("connect", () => logger.info({ dependency: "postgres" }, "PostgreSQL connection established"));
clients.postgres.on("error", (error) => logger.error({ dependency: "postgres", errorName: error.name, errorCode: "code" in error ? error.code : undefined }, "PostgreSQL pool error"));
clients.redis.on("ready", () => logger.info({ dependency: "redis" }, "Redis connection ready"));
clients.redis.on("reconnecting", (delay: number) => logger.warn({ dependency: "redis", retryDelayMs: delay }, "Redis reconnecting"));
clients.redis.on("error", (error) => logger.error({ dependency: "redis", errorName: error.name }, "Redis client error"));
const app = createApp(logger, environment, clients, {
  prisma,
  handoff: queueHandoff,
  deliveryQueue,
  searchClient,
  searchIndexer,
  ...(googleOAuthProvider ? { googleOAuthProvider } : {}),
  ...(slackOAuthProvider ? { slackOAuthProvider } : {}),
});
const server = app.listen(environment.API_PORT, "0.0.0.0", () => {
  logger.info({ port: environment.API_PORT }, "API listening");
});
void queueHandoff.start();
searchIndexer.requestDrain();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "API shutdown requested");

  server.close(async (error) => {
    if (error) logger.error({ errorName: error.name, errorCode: "code" in error ? error.code : undefined }, "HTTP server close failed");
    const [dependenciesClose, prismaClose, queueClose, searchClose] = await Promise.allSettled([
      closeInfrastructureClients(clients),
      prisma.$disconnect(),
      queueHandoff.close(),
      searchClient.close(),
    ]);
    const closeFailed = Boolean(error)
      || dependenciesClose.status === "rejected"
      || (dependenciesClose.status === "fulfilled" && dependenciesClose.value)
      || prismaClose.status === "rejected"
      || queueClose.status === "rejected"
      || searchClose.status === "rejected";
    process.exitCode = closeFailed ? 1 : 0;
    logger.info({ signal, exitCode: process.exitCode, closeFailed }, "API shutdown complete");
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
