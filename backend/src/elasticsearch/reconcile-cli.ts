import "dotenv/config";
import { createLogger, loadServerEnvironment } from "@mailflow/shared";
import { createPrismaClient } from "../db/client.js";
import { createElasticsearchClient } from "./client.js";
import { DeliverySearchIndexer } from "./indexer.js";

const environment = loadServerEnvironment();
const logger = createLogger("mailflow-search-reconcile");
const prisma = createPrismaClient(environment.DATABASE_URL);
const client = createElasticsearchClient(environment.ELASTICSEARCH_URL, environment.ELASTICSEARCH_API_KEY);
try {
  const indexer = new DeliverySearchIndexer(prisma, client, logger);
  const result = process.argv.includes("--all") ? await indexer.reindexAll() : await indexer.reconcilePending();
  logger.info(result, "search reconciliation finished");
  if (result.failed) process.exitCode = 1;
} catch (error) {
  logger.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "search reconciliation failed");
  process.exitCode = 1;
} finally {
  await Promise.allSettled([client.close(), prisma.$disconnect()]);
}
