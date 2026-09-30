import type { Client } from "@elastic/elasticsearch";
import type { Logger } from "pino";
import type { PrismaClient } from "../generated/prisma/client.js";
import { EMAIL_DELIVERY_INDEX, ensureEmailDeliveryIndex } from "./client.js";

export type DeliverySearchDocument = {
  deliveryId: string;
  userId: string;
  campaignId: string;
  recipientEmail: string;
  normalizedRecipient: string;
  subject: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class DeliverySearchIndexer {
  private drainPromise: Promise<{ indexed: number; failed: number }> | undefined;

  constructor(private readonly prisma: PrismaClient, private readonly client: Client, private readonly logger: Logger) {}

  requestDrain(limit = 100): void {
    if (this.drainPromise) return;
    this.drainPromise = this.reconcilePending(limit)
      .catch((error: unknown) => {
      this.logger.warn(searchErrorFields(error), "search index reconciliation deferred");
        return { indexed: 0, failed: 1 };
      })
      .finally(() => { this.drainPromise = undefined; });
  }

  async reconcilePending(limit = 500): Promise<{ indexed: number; failed: number }> {
    try {
      await ensureEmailDeliveryIndex(this.client);
    } catch (error) {
      await this.prisma.searchIndexOutbox.updateMany({
        where: { state: "pending" },
        data: { attempts: { increment: 1 }, lastAttemptAt: new Date(), lastError: safeIndexError(error) },
      }).catch(() => undefined);
      this.logger.warn(searchErrorFields(error), "search index is unavailable; pending delivery documents retained");
      throw error;
    }
    const pending = await this.prisma.searchIndexOutbox.findMany({
      where: { state: "pending" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
      include: { delivery: { include: { campaign: { select: { subject: true } } } } },
    });
    let indexed = 0;
    let failed = 0;
    for (const row of pending) {
      const triedAt = new Date();
      await this.prisma.searchIndexOutbox.updateMany({ where: { id: row.id, revision: row.revision }, data: { attempts: { increment: 1 }, lastAttemptAt: triedAt } });
      try {
        await this.client.index({
          index: EMAIL_DELIVERY_INDEX,
          id: row.deliveryId,
          document: toDocument(row.delivery, row.delivery.campaign.subject),
          refresh: "wait_for",
        });
        const saved = await this.prisma.searchIndexOutbox.updateMany({
          where: { id: row.id, state: "pending", revision: row.revision },
          data: { state: "indexed", indexedAt: new Date(), lastError: null },
        });
        if (saved.count === 1) indexed += 1;
      } catch (error) {
        failed += 1;
        await this.prisma.searchIndexOutbox.updateMany({
          where: { id: row.id, revision: row.revision },
          data: { lastError: safeIndexError(error) },
        }).catch(() => undefined);
        this.logger.warn({ deliveryId: row.deliveryId, userId: row.delivery.userId, campaignId: row.delivery.campaignId, ...searchErrorFields(error) }, "delivery search indexing failed; PostgreSQL outbox retained");
      }
    }
    if (indexed || failed) this.logger.info({ indexed, failed }, "search index reconciliation batch finished");
    return { indexed, failed };
  }

  async reindexAll(): Promise<{ indexed: number; failed: number }> {
    await ensureEmailDeliveryIndex(this.client);
    await this.prisma.searchIndexOutbox.updateMany({ data: { state: "pending", revision: { increment: 1 }, indexedAt: null } });
    let cursor: string | undefined;
    let indexed = 0;
    let failed = 0;
    while (true) {
      const rows = await this.prisma.emailDelivery.findMany({
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { id: "asc" },
        take: 250,
        include: { campaign: { select: { subject: true } } },
      });
      if (!rows.length) break;
      for (const row of rows) {
        try {
          const outbox = await this.prisma.searchIndexOutbox.findUnique({ where: { deliveryId: row.id }, select: { id: true, revision: true } });
          if (outbox) await this.prisma.searchIndexOutbox.updateMany({ where: { id: outbox.id, revision: outbox.revision }, data: { attempts: { increment: 1 }, lastAttemptAt: new Date() } });
          await this.client.index({ index: EMAIL_DELIVERY_INDEX, id: row.id, document: toDocument(row, row.campaign.subject), refresh: "wait_for" });
          if (outbox) await this.prisma.searchIndexOutbox.updateMany({
            where: { id: outbox.id, revision: outbox.revision },
            data: { state: "indexed", indexedAt: new Date(), lastError: null },
          });
          indexed += 1;
        } catch (error) {
          failed += 1;
          const outbox = await this.prisma.searchIndexOutbox.findUnique({ where: { deliveryId: row.id }, select: { id: true, revision: true } }).catch(() => null);
          if (outbox) await this.prisma.searchIndexOutbox.updateMany({
            where: { id: outbox.id, revision: outbox.revision },
            data: { lastAttemptAt: new Date(), lastError: safeIndexError(error) },
          }).catch(() => undefined);
          this.logger.warn({ deliveryId: row.id, userId: row.userId, campaignId: row.campaignId, ...searchErrorFields(error) }, "delivery reindex failed");
        }
      }
      cursor = rows.at(-1)?.id;
    }
    return { indexed, failed };
  }
}

function toDocument(row: {
  id: string; userId: string; campaignId: string; recipientEmail: string; normalizedRecipient: string;
  status: string; scheduledAt: Date; sentAt: Date | null; createdAt: Date; updatedAt: Date;
}, subject: string): DeliverySearchDocument {
  return {
    deliveryId: row.id, userId: row.userId, campaignId: row.campaignId,
    recipientEmail: row.recipientEmail, normalizedRecipient: row.normalizedRecipient,
    subject, status: row.status, scheduledAt: row.scheduledAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

function safeIndexError(error: unknown): string {
  const candidate = error as { name?: unknown; statusCode?: unknown } | null;
  const name = typeof candidate?.name === "string" ? candidate.name : "ElasticsearchError";
  const status = typeof candidate?.statusCode === "number" ? ` HTTP ${candidate.statusCode}` : "";
  return `${name}${status}`.slice(0, 200);
}

function searchErrorFields(error: unknown): { errorName: string; httpStatus?: number } {
  const candidate = error as { name?: unknown; statusCode?: unknown } | null;
  return {
    errorName: typeof candidate?.name === "string" ? candidate.name : "ElasticsearchError",
    ...(typeof candidate?.statusCode === "number" ? { httpStatus: candidate.statusCode } : {}),
  };
}
