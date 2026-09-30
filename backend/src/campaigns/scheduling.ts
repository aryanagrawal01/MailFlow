import { randomUUID } from "node:crypto";
import type { ServerEnvironment } from "@mailflow/shared";
import type { PrismaClient } from "../generated/prisma/client.js";
import { QueueOutboxState } from "../generated/prisma/enums.js";
import { z } from "zod";

export type ScheduleCampaignInput = {
  subject: string;
  body: string;
  recipients: string[];
  startAt: Date;
  delayMs: number;
  hourlyLimit: number;
};

export type ScheduleCampaignResult = {
  campaign: {
    id: string;
    subject: string;
    requestedStartAt: Date;
    delayMs: number;
    hourlyLimit: number;
    recipientCount: number;
    createdAt: Date;
  };
  deliveries: Array<{ id: string; recipientEmail: string; scheduledAt: Date; jobId: string }>;
};

export function campaignScheduleSchema(environment: ServerEnvironment) {
  return z.object({
    subject: z.string().trim().min(1).max(998),
    body: z.string().trim().min(1).max(100_000),
    recipients: z.array(z.string().trim().max(320).email()).min(1).max(environment.MAX_RECIPIENTS_PER_CAMPAIGN),
    startAt: z.string().datetime({ offset: true }),
    delayMs: z.number().int().min(environment.MIN_DELAY_MS).max(86_400_000),
    hourlyLimit: z.number().int().min(1).max(environment.MAX_EMAILS_PER_HOUR_PER_SENDER),
  });
}

export function normalizeRecipients(recipients: string[]): Array<{ recipientEmail: string; normalizedRecipient: string }> {
  const unique = new Map<string, string>();
  for (const recipient of recipients) {
    const displayValue = recipient.trim();
    const normalizedValue = displayValue.toLowerCase();
    if (!unique.has(normalizedValue)) unique.set(normalizedValue, displayValue);
  }
  return [...unique.entries()].map(([normalizedRecipient, recipientEmail]) => ({ recipientEmail, normalizedRecipient }));
}

export async function createCampaignSchedule(
  prisma: PrismaClient,
  userId: string,
  input: ScheduleCampaignInput,
): Promise<ScheduleCampaignResult> {
  const recipients = normalizeRecipients(input.recipients);
  const campaignId = randomUUID();
  const createdAt = new Date();
  const deliveries = recipients.map(({ recipientEmail, normalizedRecipient }, recipientPosition) => {
    const id = randomUUID();
    const scheduledAt = new Date(input.startAt.getTime() + recipientPosition * input.delayMs);
    return {
      id,
      recipientEmail,
      normalizedRecipient,
      recipientPosition,
      scheduledAt,
      jobId: `delivery-${id}`,
    };
  });

  const campaign = await prisma.$transaction(async (transaction) => {
    const savedCampaign = await transaction.campaign.create({
      data: {
        id: campaignId,
        userId,
        subject: input.subject,
        body: input.body,
        requestedStartAt: input.startAt,
        delayMs: input.delayMs,
        hourlyLimit: input.hourlyLimit,
        recipientCount: recipients.length,
        createdAt,
      },
      select: {
        id: true,
        subject: true,
        requestedStartAt: true,
        delayMs: true,
        hourlyLimit: true,
        recipientCount: true,
        createdAt: true,
      },
    });

    await transaction.emailDelivery.createMany({
      data: deliveries.map(({ id, recipientEmail, normalizedRecipient, recipientPosition, scheduledAt }) => ({
        id,
        userId,
        campaignId,
        recipientEmail,
        normalizedRecipient,
        recipientPosition,
        scheduledAt,
      })),
    });

    await transaction.queueOutbox.createMany({
      data: deliveries.map(({ id, jobId }) => ({
        userId,
        campaignId,
        deliveryId: id,
        jobId,
        state: QueueOutboxState.pending,
      })),
    });

    return savedCampaign;
  });

  return {
    campaign,
    deliveries: deliveries.map(({ id, recipientEmail, scheduledAt, jobId }) => ({
      id,
      recipientEmail,
      scheduledAt,
      jobId,
    })),
  };
}
