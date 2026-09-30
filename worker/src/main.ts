import "dotenv/config";
import { Worker, type Job } from "bullmq";
import {
  checkReadiness,
  closeInfrastructureClients,
  createDeliveryConnectionOptions,
  createDeliveryQueue,
  createInfrastructureClients,
  createLogger,
  DELIVERY_JOB_NAME,
  DELIVERY_QUEUE_NAME,
  DeliveryQueueHandoff,
  loadServerEnvironment,
  type DeliveryJobData,
} from "@mailflow/shared";
import { createPrismaClient } from "@mailflow/api/db/client.js";
import { createOutboxHandoffStore } from "@mailflow/api/queues/outbox-store.js";
import { processDelivery, settleExhaustedWorkerJob } from "./delivery-processor.js";
import { createEtherealTransport } from "./smtp.js";
import { createElasticsearchClient } from "@mailflow/api/elasticsearch/client.js";
import { DeliverySearchIndexer } from "@mailflow/api/elasticsearch/indexer.js";
import { notifySenderHourlyLimit } from "@mailflow/api/slack/alerts.js";

const environment = loadServerEnvironment();
const logger = createLogger("mailflow-worker");
const smtp = createEtherealTransport(environment);
const clients = createInfrastructureClients(environment);
const prisma = createPrismaClient(environment.DATABASE_URL);
const searchClient = createElasticsearchClient(environment.ELASTICSEARCH_URL, environment.ELASTICSEARCH_API_KEY);
const searchIndexer = new DeliverySearchIndexer(prisma, searchClient, logger);
const deliveryQueue = createDeliveryQueue(environment.REDIS_URL, {
  attempts: environment.DELIVERY_MAX_ATTEMPTS,
  retryDelayMs: Math.max(1_000, environment.MIN_DELAY_MS),
});
const queueHandoff = new DeliveryQueueHandoff(deliveryQueue, createOutboxHandoffStore(prisma), logger);

clients.postgres.on("connect", () => logger.info({ dependency: "postgres" }, "PostgreSQL connection established"));
clients.postgres.on("error", (error) => logger.error({ dependency: "postgres", errorName: error.name, errorCode: "code" in error ? error.code : undefined }, "PostgreSQL pool error"));
clients.redis.on("ready", () => logger.info({ dependency: "redis" }, "Redis connection ready"));
clients.redis.on("reconnecting", (delay: number) => logger.warn({ dependency: "redis", retryDelayMs: delay }, "Redis reconnecting"));
clients.redis.on("error", (error) => logger.error({ dependency: "redis", errorName: error.name }, "Redis client error"));

let worker: Worker<DeliveryJobData, void, typeof DELIVERY_JOB_NAME> | undefined;
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Email delivery worker shutdown requested");
  const [workerClose, dependenciesClose, prismaClose, queueClose, searchClose] = await Promise.allSettled([
    worker?.close() ?? Promise.resolve(),
    closeInfrastructureClients(clients),
    prisma.$disconnect(),
    queueHandoff.close(),
    searchClient.close(),
  ]);
  const closeFailed = workerClose.status === "rejected"
    || dependenciesClose.status === "rejected"
    || (dependenciesClose.status === "fulfilled" && dependenciesClose.value)
    || prismaClose.status === "rejected"
    || queueClose.status === "rejected"
    || searchClose.status === "rejected";
  process.exitCode = closeFailed ? 1 : 0;
  logger.info({ signal, exitCode: process.exitCode, closeFailed }, "Worker shutdown complete");
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const readiness = await checkReadiness(environment, clients, logger);
if (readiness.status !== "ready") {
  logger.fatal({ dependencies: readiness.dependencies }, "Worker could not connect to required services");
  await closeInfrastructureClients(clients);
  await prisma.$disconnect();
  await queueHandoff.close();
  process.exit(1);
}

await queueHandoff.start();
searchIndexer.requestDrain();
worker = new Worker<DeliveryJobData, void, typeof DELIVERY_JOB_NAME>(
  DELIVERY_QUEUE_NAME,
  async (job: Job<DeliveryJobData, void, typeof DELIVERY_JOB_NAME>, token: string | undefined) => {
    await processDelivery(job, token, {
      prisma,
      redis: clients.redis,
      transport: smtp.transport,
      from: smtp.from,
      maxAttempts: environment.DELIVERY_MAX_ATTEMPTS,
      minimumSpacingMs: environment.MIN_DELAY_MS,
      senderHourlyLimit: environment.MAX_EMAILS_PER_HOUR_PER_SENDER,
      logger,
      notifySenderLimit: (userId, hourWindowStart) => notifySenderHourlyLimit({
        prisma, userId, hourWindowStart,
        ...(environment.SLACK_TOKEN_ENCRYPTION_KEY ? { encryptionKey: environment.SLACK_TOKEN_ENCRYPTION_KEY } : {}),
        logger,
      }),
    });
    // This projection is best effort; DB changes and SMTP outcome are already committed.
    searchIndexer.requestDrain(50);
  },
  {
    connection: createDeliveryConnectionOptions(environment.REDIS_URL, null),
    concurrency: environment.WORKER_CONCURRENCY,
    maxStalledCount: 2,
    stalledInterval: 30_000,
  },
);
worker.on("ready", () => logger.info({ queueName: DELIVERY_QUEUE_NAME, concurrency: environment.WORKER_CONCURRENCY }, "BullMQ email worker ready"));
worker.on("error", (error) => logger.error({ queueName: DELIVERY_QUEUE_NAME, errorName: error.name }, "BullMQ worker connection error"));
worker.on("stalled", (jobId) => logger.warn({ queueName: DELIVERY_QUEUE_NAME, jobId }, "BullMQ delivery job stalled; lock recovery will retry it"));
worker.on("active", (job) => logger.info({ queueName: DELIVERY_QUEUE_NAME, jobId: job.id, deliveryId: job.data.deliveryId, attemptNumber: job.attemptsMade + 1 }, "BullMQ delivery job active"));
worker.on("completed", (job) => logger.info({ queueName: DELIVERY_QUEUE_NAME, jobId: job.id, deliveryId: job.data.deliveryId, attemptsMade: job.attemptsMade }, "BullMQ delivery job completed"));
worker.on("failed", (job, error) => {
  if (!job) return;
  void job.getState().then(async (state) => {
    const failureFields = { queueName: DELIVERY_QUEUE_NAME, jobId: job.id, deliveryId: job.data.deliveryId, attemptsMade: job.attemptsMade, maxAttempts: environment.DELIVERY_MAX_ATTEMPTS, errorName: error.name, state };
    if (state !== "failed") {
      logger.warn(failureFields, "BullMQ delivery job will retry or was deferred");
      return;
    }
    logger.error(failureFields, "BullMQ delivery job retries exhausted");
    const outcome = await settleExhaustedWorkerJob(prisma, job.data.deliveryId);
    if (outcome === "delivery_unknown") {
      logger.error({ jobId: job.id, deliveryId: job.data.deliveryId }, "delivery outcome unknown after worker retries exhausted");
    } else if (outcome === "failed") {
      logger.error({ jobId: job.id, deliveryId: job.data.deliveryId }, "delivery permanently failed after worker retries exhausted");
    }
  }).catch((settlementError: unknown) => {
    logger.error({ jobId: job.id, deliveryId: job.data.deliveryId, errorName: settlementError instanceof Error ? settlementError.name : "UnknownError" }, "could not settle exhausted delivery job");
  });
});

logger.info({
  dependencies: readiness.dependencies,
  queueName: DELIVERY_QUEUE_NAME,
  concurrency: environment.WORKER_CONCURRENCY,
  maxAttempts: environment.DELIVERY_MAX_ATTEMPTS,
}, "Ethereal delivery worker started");
