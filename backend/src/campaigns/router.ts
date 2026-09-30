import { Router } from "express";
import type { Logger } from "pino";
import type { ServerEnvironment } from "@mailflow/shared";
import { DELIVERY_QUEUE_NAME } from "@mailflow/shared";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { DeliveryQueueHandoff } from "@mailflow/shared";
import { campaignScheduleSchema, createCampaignSchedule } from "./scheduling.js";
import { z } from "zod";
import type { DeliverySearchIndexer } from "../elasticsearch/indexer.js";

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const statusSchema = z.enum(["scheduled", "processing", "sent", "failed", "delivery_unknown"]);

export function createCampaignRouter(options: {
  environment: ServerEnvironment;
  prisma: PrismaClient;
  handoff: Pick<DeliveryQueueHandoff, "reconcile">;
  logger: Logger;
  searchIndexer?: DeliverySearchIndexer;
}) {
  const { environment, prisma, handoff, logger, searchIndexer } = options;
  const router = Router();

  router.post("/", async (request, response, next) => {
    const userId = response.locals.auth?.userId;
    if (!userId) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }

    const parsed = campaignScheduleSchema(environment).safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Invalid campaign schedule",
        issues: parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
      });
      return;
    }

    const startAt = new Date(parsed.data.startAt);
    if (startAt.getTime() <= Date.now()) {
      response.status(400).json({ error: "startAt must be in the future" });
      return;
    }

    try {
      const result = await createCampaignSchedule(prisma, userId, { ...parsed.data, startAt });
      searchIndexer?.requestDrain();
      // The transaction above is the acceptance point. Redis failures leave the
      // outbox pending and do not discard the user's durable schedule.
      const handoffResult = await handoff.reconcile("campaign_created");
      logger.info({ userId, campaignId: result.campaign.id, deliveryCount: result.deliveries.length, queueName: DELIVERY_QUEUE_NAME, queueHandoff: handoffResult }, "campaign schedule accepted");
      response.status(201).json({
        campaign: result.campaign,
        deliveries: result.deliveries.map(({ jobId: _jobId, ...delivery }) => delivery),
        queueHandoff: handoffResult,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/", async (request, response, next) => {
    const userId = response.locals.auth?.userId;
    if (!userId) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }
    const parsed = paginationSchema.safeParse({ page: request.query.page, pageSize: request.query.pageSize });
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid pagination parameters" });
      return;
    }
    const { page, pageSize } = parsed.data;
    try {
      const where = { userId };
      const [items, total] = await Promise.all([
        prisma.campaign.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { _count: { select: { deliveries: true } } },
        }),
        prisma.campaign.count({ where }),
      ]);
      response.json({ items, total, page, pageSize });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:campaignId/deliveries", async (request, response, next) => {
    const userId = response.locals.auth?.userId;
    if (!userId) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }
    const campaignId = request.params.campaignId;
    if (!campaignId || !z.string().uuid().safeParse(campaignId).success) {
      response.status(400).json({ error: "Invalid campaign ID" });
      return;
    }
    const parsed = parseDeliveryListQuery(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid delivery pagination or filter" });
      return;
    }

    try {
      const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, userId }, select: { id: true } });
      if (!campaign) {
        response.status(404).json({ error: "Campaign not found" });
        return;
      }
      const { page, pageSize, status } = parsed.data;
      const where = { campaignId, userId, ...(status ? { status } : {}) };
      const [items, total] = await Promise.all([
        prisma.emailDelivery.findMany({
          where,
          orderBy: [{ recipientPosition: "asc" }, { id: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.emailDelivery.count({ where }),
      ]);
      response.json({ campaignId, items, total, page, pageSize });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function parseDeliveryListQuery(query: Record<string, unknown>) {
  return z.object({
    page: paginationSchema.shape.page,
    pageSize: paginationSchema.shape.pageSize,
    status: statusSchema.optional(),
  }).safeParse({ page: query.page, pageSize: query.pageSize, status: query.status });
}

export function createDeliveryListRouter(prisma: PrismaClient) {
  const router = Router();
  router.get("/", async (request, response, next) => {
    const userId = response.locals.auth?.userId;
    if (!userId) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }
    const parsed = z.object({
      page: paginationSchema.shape.page,
      pageSize: paginationSchema.shape.pageSize,
      status: statusSchema.optional(),
      campaignId: z.string().uuid().optional(),
    }).safeParse({
      page: request.query.page,
      pageSize: request.query.pageSize,
      status: request.query.status,
      campaignId: request.query.campaignId,
    });
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid delivery pagination or filter" });
      return;
    }
    const { page, pageSize, status, campaignId } = parsed.data;
    const where = { userId, ...(campaignId ? { campaignId } : {}), ...(status ? { status } : {}) };
    try {
      const [items, total] = await Promise.all([
        prisma.emailDelivery.findMany({
          where,
          orderBy: [{ scheduledAt: "asc" }, { recipientPosition: "asc" }, { id: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { campaign: { select: { id: true, subject: true } } },
        }),
        prisma.emailDelivery.count({ where }),
      ]);
      response.json({ items, total, page, pageSize });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
