import type { Logger } from "pino";
import type { PrismaClient } from "../generated/prisma/client.js";
import { decryptSlackToken } from "./token-crypto.js";
import { slackApi, type SlackApi } from "./client.js";

export async function notifySenderHourlyLimit(options: {
  prisma: PrismaClient;
  userId: string;
  hourWindowStart: Date;
  encryptionKey?: string;
  logger: Logger;
  api?: SlackApi;
}): Promise<void> {
  const { prisma, userId, hourWindowStart, encryptionKey, logger } = options;
  let created: number;
  try {
    const inserted = await prisma.slackAlert.createMany({
      data: [{ userId, hourWindowStart, status: "pending" }],
      skipDuplicates: true,
    });
    created = inserted.count;
  } catch (error) {
    logger.warn({ userId, hourWindowStart, errorName: error instanceof Error ? error.name : "UnknownError" }, "Slack rate alert could not be recorded");
    return;
  }
  if (created !== 1) {
    // A process may have stopped after inserting the unique alert but before
    // posting it. Pending alerts are safely resumed under a database row lock.
    const existing = await prisma.slackAlert.findUnique({ where: { userId_hourWindowStart: { userId, hourWindowStart } } });
    if (existing?.status !== "pending") return;
  }
  await deliverAlert({
    prisma, userId, hourWindowStart, logger, api: options.api ?? slackApi,
    ...(encryptionKey ? { encryptionKey } : {}),
  });
}

export async function flushSkippedSenderAlerts(options: {
  prisma: PrismaClient;
  userId: string;
  encryptionKey?: string;
  logger: Logger;
  api?: SlackApi;
}): Promise<void> {
  const now = new Date();
  const hourWindowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  const skipped = await options.prisma.slackAlert.findMany({ where: { userId: options.userId, hourWindowStart, status: "skipped" } });
  for (const alert of skipped) {
    const claimed = await options.prisma.slackAlert.updateMany({ where: { id: alert.id, status: "skipped" }, data: { status: "pending", errorCode: null } });
    if (claimed.count !== 1) continue;
    await deliverAlert({
      prisma: options.prisma, userId: alert.userId, hourWindowStart: alert.hourWindowStart,
      logger: options.logger, api: options.api ?? slackApi,
      ...(options.encryptionKey ? { encryptionKey: options.encryptionKey } : {}),
    });
  }
}

async function deliverAlert(options: {
  prisma: PrismaClient;
  userId: string;
  hourWindowStart: Date;
  encryptionKey?: string;
  logger: Logger;
  api: SlackApi;
}): Promise<void> {
  const { prisma, userId, hourWindowStart, encryptionKey, logger, api } = options;
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM slack_alerts
      WHERE user_id = ${userId}::uuid AND hour_window_start = ${hourWindowStart}
      FOR UPDATE
    `;
    const id = locked[0]?.id;
    if (!id) return;
    const alert = await tx.slackAlert.findUnique({ where: { id } });
    if (!alert || alert.status !== "pending") return;
    const connection = await tx.slackConnection.findFirst({ where: { userId, disconnectedAt: null } });
    if (!connection || !connection.channelId || !encryptionKey) {
      await tx.slackAlert.update({ where: { id }, data: { status: "skipped", errorCode: "SLACK_NOT_CONNECTED" } });
      logger.info({ userId, hourWindowStart }, "sender limit reached without an active Slack channel");
      return;
    }
    try {
      const token = decryptSlackToken(connection.botTokenEncrypted, encryptionKey);
      const hourLabel = hourWindowStart.toISOString().slice(0, 13) + ":00 UTC";
      const slackMessageTs = await api.postMessage(token, connection.channelId, `MailFlow sender hourly limit reached for this UTC hour (${hourLabel}). Additional emails are queued for the next eligible hour.`);
      await tx.slackAlert.update({ where: { id }, data: { status: "sent", sentAt: new Date(), slackMessageTs, errorCode: null } });
      logger.info({ userId, hourWindowStart, channelId: connection.channelId }, "sender limit Slack alert sent");
    } catch (error) {
      const errorCode = error instanceof Error && "slackCode" in error && typeof error.slackCode === "string" ? error.slackCode.slice(0, 100) : "SLACK_REQUEST_FAILED";
      await tx.slackAlert.update({ where: { id }, data: { status: "failed", errorCode } });
      logger.warn({ userId, hourWindowStart, errorCode }, "Slack alert failed; email delivery continues");
    }
  });
}
