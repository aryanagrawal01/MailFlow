import { Queue } from "bullmq";
import type { Logger } from "pino";

export const DELIVERY_QUEUE_NAME = "mailflow-email-deliveries";
export const DELIVERY_JOB_NAME = "email-delivery";
export const DELIVERY_JOB_RETENTION = Object.freeze({
  completed: Object.freeze({ age: 7 * 24 * 60 * 60, count: 10_000 }),
  failed: Object.freeze({ age: 30 * 24 * 60 * 60, count: 20_000 }),
});
const HANDOFF_BATCH_SIZE = 100;

export interface DeliveryJobData {
  deliveryId: string;
}

export interface PendingOutboxRow {
  id: string;
  deliveryId: string;
  jobId: string;
  scheduledAt: Date;
}

export interface OutboxHandoffStore {
  findPending(afterId: string | null, limit: number): Promise<PendingOutboxRow[]>;
  markEnqueued(ids: string[], at: Date): Promise<number>;
  markFailure(ids: string[], at: Date, message: string): Promise<void>;
}

export interface ReconcileResult {
  attempted: number;
  enqueued: number;
  failedBatches: number;
}

export function getDeliveryJobId(deliveryId: string): string {
  return `delivery-${deliveryId}`;
}

export function createDeliveryConnectionOptions(redisUrl: string, maxRetriesPerRequest: number | null = 1) {
  const url = new URL(redisUrl);
  const database = url.pathname.length > 1 ? Number.parseInt(url.pathname.slice(1), 10) : undefined;
  const connection = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(database !== undefined && Number.isInteger(database) ? { db: database } : {}),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
    ...(maxRetriesPerRequest === 1 ? { enableOfflineQueue: false } : {}),
    maxRetriesPerRequest,
    retryStrategy: (attempt: number) => Math.min(attempt * 250, 5_000),
  };

  return connection;
}

export function createDeliveryQueue(
  redisUrl: string,
  options: { attempts?: number; retryDelayMs?: number } = {},
): Queue<DeliveryJobData, void, typeof DELIVERY_JOB_NAME> {
  const attempts = options.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new RangeError("Delivery queue attempts must be an integer between 1 and 10");
  }
  const connection = createDeliveryConnectionOptions(redisUrl, 1);
  const queue = new Queue<DeliveryJobData, void, typeof DELIVERY_JOB_NAME>(DELIVERY_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts,
      backoff: { type: "exponential", delay: options.retryDelayMs ?? 1_000 },
      removeOnComplete: DELIVERY_JOB_RETENTION.completed,
      removeOnFail: DELIVERY_JOB_RETENTION.failed,
    },
  });
  // Consumers attach an error handler at construction time to avoid unhandled EventEmitter errors.
  queue.on("error", () => undefined);
  queue.getBackend().on("error", () => undefined);
  return queue;
}

/**
 * Replays durable PostgreSQL outbox records into BullMQ. Deterministic job IDs
 * make concurrent/retried additions converge on the same retained queue job.
 */
export class DeliveryQueueHandoff {
  private activeReconciliation: Promise<ReconcileResult> | undefined;
  private pendingReason: string | undefined;

  constructor(
    private readonly queue: Queue<DeliveryJobData, void, typeof DELIVERY_JOB_NAME>,
    private readonly store: OutboxHandoffStore,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {
    queue.getBackend().on("error", (error: Error) => {
      logger.warn({ queueName: DELIVERY_QUEUE_NAME, err: safeError(error) }, "delivery queue connection error");
    });
    queue.getBackend().on("ready", () => {
      logger.info({ queueName: DELIVERY_QUEUE_NAME }, "delivery queue Redis connection ready; reconciling outbox");
      void this.reconcile("redis_ready").catch((error: unknown) => {
        logger.error({ queueName: DELIVERY_QUEUE_NAME, err: safeError(error) }, "delivery queue reconnect reconciliation failed");
      });
    });
  }

  reconcile(reason: string): Promise<ReconcileResult> {
    if (this.activeReconciliation) {
      // A trigger during a scan may correspond to an outbox row inserted with
      // an ID that sorts before the scan cursor. Queue one more pass so it is
      // never left waiting for an unrelated restart or Redis reconnect.
      this.pendingReason = reason;
      return this.activeReconciliation;
    }
    this.activeReconciliation = (async () => {
      let currentReason: string | undefined = reason;
      let result: ReconcileResult = { attempted: 0, enqueued: 0, failedBatches: 0 };
      while (currentReason) {
        this.pendingReason = undefined;
        result = await this.reconcilePending(currentReason);
        currentReason = this.pendingReason;
      }
      return result;
    })().finally(() => {
      this.activeReconciliation = undefined;
    });
    return this.activeReconciliation;
  }

  async start(): Promise<void> {
    try {
      await this.queue.waitUntilReady();
      await this.reconcile("startup");
    } catch (error) {
      // Keep the API/worker alive: pending PostgreSQL outbox rows remain durable
      // and the Redis ready event will trigger another attempt after reconnect.
      this.logger.warn({ err: safeError(error) }, "initial delivery queue reconciliation deferred");
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }

  private async reconcilePending(reason: string): Promise<ReconcileResult> {
    const result: ReconcileResult = { attempted: 0, enqueued: 0, failedBatches: 0 };
    let afterId: string | null = null;

    try {
      for (;;) {
        const rows = await this.store.findPending(afterId, HANDOFF_BATCH_SIZE);
        if (rows.length === 0) break;
        afterId = rows[rows.length - 1]!.id;
        result.attempted += rows.length;

        try {
          const queuedAt = this.now();
          await this.queue.addBulk(rows.map((row) => ({
            name: DELIVERY_JOB_NAME,
            data: { deliveryId: row.deliveryId },
            opts: {
              jobId: row.jobId,
              delay: Math.max(0, row.scheduledAt.getTime() - queuedAt.getTime()),
            },
          })));
          await this.store.markEnqueued(rows.map((row) => row.id), queuedAt);
          result.enqueued += rows.length;
        } catch (error) {
          result.failedBatches += 1;
          const message = safeError(error);
          this.logger.error({ reason, queueName: DELIVERY_QUEUE_NAME, deliveryIds: rows.map((row) => row.deliveryId), jobIds: rows.map((row) => row.jobId), err: message }, "delivery queue handoff deferred");
          try {
            await this.store.markFailure(rows.map((row) => row.id), this.now(), message);
          } catch (recordError) {
            this.logger.error({ reason, outboxCount: rows.length, err: safeError(recordError) }, "could not record outbox handoff failure");
          }
        }
      }
    } catch (error) {
      result.failedBatches += 1;
      this.logger.error({ reason, afterId, err: safeError(error) }, "outbox scan failed; durable rows remain pending");
    }

    this.logger.info({ reason, queueName: DELIVERY_QUEUE_NAME, ...result }, "delivery queue reconciliation finished");
    return result;
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message
    .replace(/((?:rediss?|postgres(?:ql)?):\/\/)[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/\b(password|token|secret|authorization|client_secret)\s*[:=]\s*[^&\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 1_000);
}
