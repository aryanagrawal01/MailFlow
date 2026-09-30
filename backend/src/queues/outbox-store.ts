import type { OutboxHandoffStore } from "@mailflow/shared";
import { QueueOutboxState } from "../generated/prisma/enums.js";
import type { PrismaClient } from "../generated/prisma/client.js";

export function createOutboxHandoffStore(prisma: PrismaClient): OutboxHandoffStore {
  return {
    async findPending(afterId, limit) {
      const rows = await prisma.queueOutbox.findMany({
        where: {
          state: QueueOutboxState.pending,
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        orderBy: { id: "asc" },
        take: limit,
        select: { id: true, deliveryId: true, jobId: true, delivery: { select: { scheduledAt: true } } },
      });
      return rows.map((row) => ({ ...row, scheduledAt: row.delivery.scheduledAt }));
    },

    async markEnqueued(ids, at) {
      const result = await prisma.queueOutbox.updateMany({
        where: { id: { in: ids }, state: QueueOutboxState.pending },
        data: {
          state: QueueOutboxState.enqueued,
          enqueuedAt: at,
          lastAttemptAt: at,
          lastError: null,
          dispatchAttempts: { increment: 1 },
        },
      });
      return result.count;
    },

    async markFailure(ids, at, message) {
      await prisma.queueOutbox.updateMany({
        where: { id: { in: ids }, state: QueueOutboxState.pending },
        data: {
          dispatchAttempts: { increment: 1 },
          lastAttemptAt: at,
          lastError: message,
        },
      });
    },
  };
}
