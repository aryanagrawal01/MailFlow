import { Router } from "express";
import { z } from "zod";
import type { Client } from "@elastic/elasticsearch";
import { EMAIL_DELIVERY_INDEX } from "./client.js";
import type { DeliverySearchIndexer } from "./indexer.js";

const dateValue = z.string().datetime({ offset: true }).optional();
const querySchema = z.object({
  recipient: z.string().trim().min(1).max(320).optional(),
  subject: z.string().trim().min(1).max(998).optional(),
  status: z.enum(["scheduled", "processing", "sent", "failed", "delivery_unknown"]).optional(),
  scheduledFrom: dateValue,
  scheduledTo: dateValue,
  sentFrom: dateValue,
  sentTo: dateValue,
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).superRefine((value, context) => {
  for (const [fromKey, toKey] of [["scheduledFrom", "scheduledTo"], ["sentFrom", "sentTo"]] as const) {
    const from = value[fromKey]; const to = value[toKey];
    if (from && to && Date.parse(from) > Date.parse(to)) context.addIssue({ code: "custom", path: [fromKey], message: "Start timestamp must be before end timestamp" });
  }
});

export function createDeliverySearchRouter(client: Client, indexer: DeliverySearchIndexer) {
  const router = Router();
  router.get("/", async (request, response) => {
    const userId = response.locals.auth?.userId;
    if (!userId) { response.status(401).json({ error: "Authentication required" }); return; }
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid search query", issues: parsed.error.issues.map(({ path, message }) => ({ field: path.join("."), message })) });
      return;
    }
    const { recipient, subject, status, scheduledFrom, scheduledTo, sentFrom, sentTo, page, pageSize } = parsed.data;
    try {
      // Opportunistically repair a small backlog; search remains isolated if ES is down.
      indexer.requestDrain(25);
      const filters: object[] = [{ term: { userId } }];
      if (status) filters.push({ term: { status } });
      if (scheduledFrom || scheduledTo) filters.push({ range: { scheduledAt: { ...(scheduledFrom ? { gte: scheduledFrom } : {}), ...(scheduledTo ? { lte: scheduledTo } : {}) } } });
      if (sentFrom || sentTo) filters.push({ range: { sentAt: { ...(sentFrom ? { gte: sentFrom } : {}), ...(sentTo ? { lte: sentTo } : {}) } } });
      const must: object[] = [];
      if (recipient) must.push({ wildcard: { normalizedRecipient: { value: `*${escapeWildcard(recipient.toLowerCase())}*` } } });
      if (subject) must.push({ match: { subject: { query: subject, operator: "and" } } });
      const result = await client.search({
        index: EMAIL_DELIVERY_INDEX,
        from: (page - 1) * pageSize,
        size: pageSize,
        track_total_hits: true,
        query: { bool: { filter: filters, ...(must.length ? { must } : {}) } },
        sort: [{ scheduledAt: "desc" }, { deliveryId: "asc" }],
      });
      const total = typeof result.hits.total === "number" ? result.hits.total : result.hits.total?.value ?? 0;
      response.json({ items: result.hits.hits.map((hit) => hit._source), total, page, pageSize });
    } catch {
      response.status(503).json({ error: "Email search is temporarily unavailable" });
    }
  });
  return router;
}

function escapeWildcard(value: string): string {
  return value.replace(/[\\*?]/g, "\\$&");
}
