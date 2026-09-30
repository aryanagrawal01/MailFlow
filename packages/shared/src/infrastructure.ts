import { Pool } from "pg";
import { Redis } from "ioredis";
import type { ServerEnvironment } from "./env.js";
import type { Logger } from "pino";

export type DependencyState = "ok" | "error";
export type ReadinessResult = {
  status: "ready" | "not_ready";
  dependencies: {
    postgres: DependencyState;
    redis: DependencyState;
    elasticsearch: DependencyState;
  };
};

export function createInfrastructureClients(environment: ServerEnvironment) {
  const postgres = new Pool({
    connectionString: environment.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    max: 10,
  });
  const redis = new Redis(environment.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    // Keep reconnecting after Redis restarts so workers can resume atomic
    // rate reservations without resetting the durable Redis counters.
    retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
  });

  return { postgres, redis };
}

export async function closeInfrastructureClients(clients: ReturnType<typeof createInfrastructureClients>): Promise<boolean> {
  const redisClose = clients.redis.status === "ready"
    ? clients.redis.quit()
    : Promise.resolve(clients.redis.disconnect());
  const results = await Promise.allSettled([clients.postgres.end(), redisClose]);
  return results.some((result) => result.status === "rejected");
}

export async function checkReadiness(
  environment: ServerEnvironment,
  clients: ReturnType<typeof createInfrastructureClients>,
  logger?: Logger,
): Promise<ReadinessResult> {
  const dependencies = { postgres: "error", redis: "error", elasticsearch: "error" } as const;
  const state: Record<keyof typeof dependencies, DependencyState> = { ...dependencies };

  const checks = await Promise.allSettled([
    clients.postgres.query("SELECT 1"),
    pingRedis(clients.redis),
    checkElasticsearch(environment.ELASTICSEARCH_URL, environment.ELASTICSEARCH_API_KEY),
  ]);

  const keys = Object.keys(state) as Array<keyof typeof state>;
  checks.forEach((result, index) => {
    const key = keys[index];
    if (!key) return;
    if (result.status === "fulfilled") {
      state[key] = "ok";
      return;
    }

    logger?.warn({ dependency: key, err: safeErrorMessage(result.reason) }, "readiness dependency check failed");
  });

  // Elasticsearch is an eventually consistent search projection. PostgreSQL
  // and Redis are the dependencies required to accept and process delivery work.
  const ready = state.postgres === "ok" && state.redis === "ok";
  return { status: ready ? "ready" : "not_ready", dependencies: state };
}

async function pingRedis(redis: Redis): Promise<void> {
  if (redis.status === "wait" || redis.status === "end") {
    await redis.connect();
  }
  await redis.ping();
}

async function checkElasticsearch(url: string, apiKey?: string): Promise<void> {
  const response = await fetch(new URL("/_cluster/health", url), {
    signal: AbortSignal.timeout(2_000),
    ...(apiKey ? { headers: { authorization: `ApiKey ${apiKey}` } } : {}),
  });
  if (!response.ok) {
    throw new Error(`Elasticsearch returned HTTP ${response.status}`);
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown dependency error";
}
