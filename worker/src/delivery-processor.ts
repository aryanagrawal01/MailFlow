import { DelayedError, type Job } from "bullmq";
import type { Logger } from "pino";
import { acquireSenderSpacing, reserveDeliveryRateSlot, type DeliveryJobData } from "@mailflow/shared";
import type { createInfrastructureClients } from "@mailflow/shared";
import type { createPrismaClient } from "@mailflow/api/db/client.js";

type PrismaClient = ReturnType<typeof createPrismaClient>;

export interface MailResult {
  messageId?: string;
  accepted?: Array<string | { address: string }>;
  rejected?: Array<string | { address: string }>;
  response?: string;
}

export interface EmailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<MailResult>;
}

type FailureKind = "retryable" | "permanent" | "unknown";

export function classifySmtpFailure(error: unknown): FailureKind {
  const candidate = error as { responseCode?: unknown; code?: unknown; command?: unknown } | null;
  const responseCode = Number(candidate?.responseCode);
  if (Number.isInteger(responseCode) && responseCode >= 500 && responseCode <= 599) return "permanent";
  if (Number.isInteger(responseCode) && responseCode >= 400 && responseCode <= 499) return "retryable";

  const code = typeof candidate?.code === "string" ? candidate.code.toUpperCase() : "";
  const command = typeof candidate?.command === "string" ? candidate.command.toUpperCase() : "";
  const knownConnectionFailure = ["ECONNECTION", "ECONNREFUSED", "ETIMEDOUT", "ESOCKET"].includes(code);
  const knownPreDataCommand = !command
    || ["CONN", "CONNECT", "EHLO", "HELO", "MAIL FROM", "RCPT TO"].includes(command)
    || command.startsWith("AUTH");
  const preDataConnectionFailure = knownConnectionFailure && knownPreDataCommand;
  return preDataConnectionFailure ? "retryable" : "unknown";
}

export class RetryableSmtpError extends Error {
  constructor() {
    super("SMTP rejected the message temporarily before accepting it");
    this.name = "RetryableSmtpError";
  }
}

interface LockedDelivery {
  id: string;
  status: string;
  user_id: string;
  campaign_id: string;
  scheduled_at: Date;
  send_started_at: Date | null;
}

interface AttemptHandle {
  deliveryId: string;
  attemptId: string;
  attemptNumber: number;
  userId: string;
  campaignId: string;
  campaignHourlyLimit: number;
  scheduledAt: Date;
  smtpAttemptNumber: number;
  recipient: string;
  subject: string;
  body: string;
}

export async function processDelivery(
  job: Job<DeliveryJobData>,
  token: string | undefined,
  dependencies: {
    prisma: PrismaClient;
    redis: ReturnType<typeof createInfrastructureClients>["redis"];
    transport: EmailTransport;
    from: string;
    maxAttempts: number;
    minimumSpacingMs: number;
    senderHourlyLimit: number;
    logger: Logger;
    notifySenderLimit?: (userId: string, hourWindowStart: Date) => Promise<void>;
    now?: () => Date;
  },
): Promise<void> {
  const { prisma, redis, transport, from, maxAttempts, minimumSpacingMs, senderHourlyLimit, logger } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const deliveryId = job.data.deliveryId;
  const queueJobId = job.id ?? `delivery-${deliveryId}`;
  logger.info({ jobId: job.id, deliveryId, attemptsMade: job.attemptsMade }, "delivery job received");

  const claim = await beginDeliveryAttempt(prisma, deliveryId, queueJobId, maxAttempts, now());
  if (claim.kind !== "claimed") {
    logger.info({ jobId: job.id, deliveryId, state: claim.kind }, "delivery job skipped");
    return;
  }

  const attempt = claim.attempt;
  logger.info({ jobId: job.id, deliveryId, attemptId: attempt.attemptId, attemptNumber: attempt.attemptNumber, userId: attempt.userId, campaignId: attempt.campaignId }, "delivery claimed; attempt started");

  const rateSlot = await reserveDeliveryRateSlot(redis, {
    deliveryId,
    userId: attempt.userId,
    campaignId: attempt.campaignId,
    notBeforeMs: attempt.scheduledAt.getTime(),
    minimumSpacingMs,
    senderHourlyLimit,
    campaignHourlyLimit: attempt.campaignHourlyLimit,
  }, now().getTime());
  if (rateSlot.eligibleAtMs > now().getTime()) {
    if (rateSlot.senderLimitReachedHourStartMs && dependencies.notifySenderLimit) {
      try {
        await dependencies.notifySenderLimit(attempt.userId, new Date(rateSlot.senderLimitReachedHourStartMs));
      } catch (error) {
        logger.warn({ userId: attempt.userId, errorName: error instanceof Error ? error.name : "UnknownError" }, "Slack sender-limit alert failed; delivery remains scheduled");
      }
    }
    await deferForTiming(job, token, prisma, attempt, rateSlot.eligibleAtMs, "HOURLY_LIMIT_DEFERRED", logger);
    throw new DelayedError();
  }

  const spacing = await acquireSenderSpacing(redis, attempt.userId, attempt.attemptId, minimumSpacingMs, now().getTime());
  if (!spacing.acquired) {
    await deferForTiming(job, token, prisma, attempt, spacing.eligibleAtMs, "SENDER_SPACING_DEFERRED", logger);
    throw new DelayedError();
  }

  const smtpStartedAt = now();
  const smtpBoundary = await markSmtpStarted(prisma, attempt, smtpStartedAt);
  if (!smtpBoundary) {
    logger.warn({ jobId: job.id, deliveryId, attemptId: attempt.attemptId }, "delivery claim changed before SMTP; send skipped");
    return;
  }

  try {
    const result = await transport.sendMail({
      from,
      to: attempt.recipient,
      subject: attempt.subject,
      text: attempt.body,
    });
    const isAccepted = result.accepted?.some((item) => acceptedAddress(item).toLowerCase() === attempt.recipient.toLowerCase());
    const isRejected = result.rejected?.some((item) => acceptedAddress(item).toLowerCase() === attempt.recipient.toLowerCase());
    if (isRejected || (result.accepted && !isAccepted)) {
      const classification = classifySmtpFailure({ responseCode: parseResponseCode(result.response) });
      const error = new Error("SMTP did not accept the recipient");
      Object.assign(error, { responseCode: parseResponseCode(result.response) });
      const retryAllowed = classification === "retryable" && attempt.smtpAttemptNumber < maxAttempts;
      await persistFailure(prisma, attempt, classification, error, now(), retryAllowed);
      if (retryAllowed) {
        logger.warn({ deliveryId, attemptId: attempt.attemptId, smtpResponseCode: parseResponseCode(result.response) }, "delivery scheduled for retry");
        throw new RetryableSmtpError();
      }
      if (classification === "unknown") logger.error({ deliveryId, attemptId: attempt.attemptId }, "delivery outcome unknown");
      else logger.warn({ deliveryId, attemptId: attempt.attemptId }, "permanent delivery failure");
      return;
    }

    const sentAt = now();
    const saved = await persistSuccess(prisma, attempt, result.messageId ?? null, sentAt);
    if (saved) {
      logger.info({ deliveryId, attemptId: attempt.attemptId, smtpMessageId: result.messageId ?? null, sentAt }, "SMTP delivery succeeded");
    } else {
      logger.error({ deliveryId, attemptId: attempt.attemptId, smtpMessageId: result.messageId ?? null }, "SMTP accepted message but database state changed; delivery outcome unknown");
    }
  } catch (error) {
    if (error instanceof RetryableSmtpError) throw error;
    const classification = classifySmtpFailure(error);
    const retryAllowed = classification === "retryable" && attempt.smtpAttemptNumber < maxAttempts;
    await persistFailure(prisma, attempt, classification, error, now(), retryAllowed);
    if (retryAllowed) {
      logger.warn({ deliveryId, attemptId: attempt.attemptId, ...safeFailureFields(error) }, "delivery scheduled for retry");
      throw new RetryableSmtpError();
    }
    if (classification === "unknown") {
      logger.error({ deliveryId, attemptId: attempt.attemptId, ...safeFailureFields(error) }, "delivery outcome unknown; automatic resend stopped");
      return;
    }
    logger.warn({ deliveryId, attemptId: attempt.attemptId, ...safeFailureFields(error) }, "permanent delivery failure");
  }
}

async function beginDeliveryAttempt(prisma: PrismaClient, deliveryId: string, queueJobId: string, maxAttempts: number, at: Date): Promise<
  { kind: "claimed"; attempt: AttemptHandle } | { kind: "sent" | "failed" | "delivery_unknown" | "missing" | "exhausted" | "already_processing" }
> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedDelivery[]>`
      SELECT id, status, user_id, campaign_id, scheduled_at, send_started_at
      FROM email_deliveries
      WHERE id = ${deliveryId}::uuid
      FOR UPDATE
    `;
    const delivery = rows[0];
    if (!delivery) return { kind: "missing" };
    if (["sent", "failed", "delivery_unknown"].includes(delivery.status)) return { kind: delivery.status as "sent" | "failed" | "delivery_unknown" };

    const latest = await tx.deliveryAttempt.findFirst({
      where: { deliveryId },
      orderBy: { attemptNumber: "desc" },
    });

    if (delivery.status === "processing" && latest?.queueJobId !== queueJobId) {
      return { kind: "already_processing" };
    }

    if (delivery.status === "processing" && (delivery.send_started_at || latest?.smtpStartedAt)) {
      await tx.emailDelivery.updateMany({
        where: { id: deliveryId, status: "processing" },
        data: {
          status: "delivery_unknown",
          failureCode: "SMTP_OUTCOME_UNKNOWN",
          failureMessage: "The worker stopped after SMTP submission may have started; automatic resend was suppressed.",
        },
      });
      if (latest?.outcome === "in_progress") {
        await tx.deliveryAttempt.update({
          where: { id: latest.id },
          data: { outcome: "delivery_unknown", finishedAt: at, errorCode: "SMTP_OUTCOME_UNKNOWN", errorMessage: "Worker exited after the SMTP boundary." },
        });
      }
      return { kind: "delivery_unknown" };
    }

    if (latest?.outcome === "in_progress") {
      await tx.deliveryAttempt.update({
        where: { id: latest.id },
        data: {
          outcome: "retryable_failure",
          finishedAt: at,
          errorCode: "WORKER_INTERRUPTED_BEFORE_SMTP",
          errorMessage: "Worker stopped before SMTP submission began; safe to retry.",
        },
      });
    }

    const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
    const smtpAttemptNumber = await tx.deliveryAttempt.count({ where: { deliveryId, smtpStartedAt: { not: null } } }) + 1;
    if (smtpAttemptNumber > maxAttempts) {
      await tx.emailDelivery.updateMany({
        where: { id: deliveryId, status: { in: ["scheduled", "processing"] } },
        data: { status: "failed", failureCode: "RETRY_LIMIT_REACHED", failureMessage: "The bounded delivery retry limit was reached before a successful SMTP submission." },
      });
      await tx.deliveryAttempt.create({
        data: {
          userId: delivery.user_id,
          deliveryId,
          queueJobId,
          attemptNumber,
          outcome: "permanent_failure",
          startedAt: at,
          finishedAt: at,
          errorCode: "RETRY_LIMIT_REACHED",
          errorMessage: "No SMTP request was made because the bounded retry limit was reached.",
        },
      });
      return { kind: "exhausted" };
    }

    const saved = await tx.emailDelivery.updateMany({
      where: { id: deliveryId, status: { in: ["scheduled", "processing"] } },
      data: { status: "processing", sendStartedAt: null },
    });
    if (saved.count !== 1) return { kind: "missing" };
    const attempt = await tx.deliveryAttempt.create({
      data: { userId: delivery.user_id, deliveryId, queueJobId, attemptNumber, startedAt: at },
    });
    const campaign = await tx.campaign.findFirst({
      where: { id: delivery.campaign_id, userId: delivery.user_id },
      select: { subject: true, body: true, hourlyLimit: true },
    });
    const address = await tx.emailDelivery.findUnique({ where: { id: deliveryId }, select: { recipientEmail: true } });
    if (!campaign || !address) throw new Error("Delivery campaign or recipient record is missing");
    return {
      kind: "claimed",
      attempt: {
        deliveryId,
        attemptId: attempt.id,
        attemptNumber,
        smtpAttemptNumber,
        userId: delivery.user_id,
        campaignId: delivery.campaign_id,
        campaignHourlyLimit: campaign.hourlyLimit,
        scheduledAt: delivery.scheduled_at,
        recipient: address.recipientEmail,
        subject: campaign.subject,
        body: campaign.body,
      },
    };
  });
}

async function deferForTiming(
  job: Job<DeliveryJobData>,
  token: string | undefined,
  prisma: PrismaClient,
  attempt: AttemptHandle,
  eligibleAtMs: number,
  reasonCode: "HOURLY_LIMIT_DEFERRED" | "SENDER_SPACING_DEFERRED",
  logger: Logger,
): Promise<void> {
  const deferredAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.deliveryAttempt.updateMany({
      where: { id: attempt.attemptId, outcome: "in_progress", smtpStartedAt: null },
      data: {
        outcome: "retryable_failure",
        finishedAt: deferredAt,
        errorCode: reasonCode,
        errorMessage: "Delivery is held for its next distributed sender/campaign timing slot.",
      },
    });
    await tx.emailDelivery.updateMany({
      where: { id: attempt.deliveryId, status: "processing", sendStartedAt: null },
      data: { status: "scheduled" },
    });
  });

  const targetAt = Math.max(eligibleAtMs, Date.now() + 1);
  await job.moveToDelayed(targetAt, token);
  logger.info({ jobId: job.id, deliveryId: attempt.deliveryId, userId: attempt.userId, campaignId: attempt.campaignId, reasonCode, eligibleAt: new Date(targetAt).toISOString() }, "delivery rescheduled by distributed timing gate");
}

async function markSmtpStarted(prisma: PrismaClient, attempt: AttemptHandle, at: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const delivery = await tx.emailDelivery.updateMany({
      where: { id: attempt.deliveryId, status: "processing", sendStartedAt: null },
      data: { sendStartedAt: at },
    });
    if (delivery.count !== 1) return false;
    const savedAttempt = await tx.deliveryAttempt.updateMany({
      where: { id: attempt.attemptId, outcome: "in_progress", smtpStartedAt: null },
      data: { smtpStartedAt: at },
    });
    if (savedAttempt.count !== 1) throw new Error("Delivery attempt could not record the SMTP boundary");
    return true;
  });
}

async function persistSuccess(prisma: PrismaClient, attempt: AttemptHandle, messageId: string | null, at: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.emailDelivery.updateMany({
      where: { id: attempt.deliveryId, status: "processing", sendStartedAt: { not: null } },
      data: { status: "sent", sentAt: at, smtpMessageId: messageId, failureCode: null, failureMessage: null },
    });
    if (updated.count !== 1) return false;
    await tx.deliveryAttempt.update({
      where: { id: attempt.attemptId },
      data: { outcome: "sent", finishedAt: at, smtpMessageId: messageId, errorCode: null, errorMessage: null },
    });
    return true;
  });
}

async function persistFailure(
  prisma: PrismaClient,
  attempt: AttemptHandle,
  classification: FailureKind,
  error: unknown,
  at: Date,
  retryAllowed: boolean,
): Promise<void> {
  const code = safeFailureFields(error).smtpErrorCode ?? (classification === "unknown" ? "SMTP_OUTCOME_UNKNOWN" : "SMTP_REJECTED");
  const message = safeFailureMessage(error);
  await prisma.$transaction(async (tx) => {
    const current = await tx.emailDelivery.findFirst({ where: { id: attempt.deliveryId, status: "processing" }, select: { id: true } });
    if (!current) return;
    const outcome = classification === "retryable" ? "retryable_failure" : classification === "permanent" ? "permanent_failure" : "delivery_unknown";
    await tx.deliveryAttempt.updateMany({
      where: { id: attempt.attemptId, outcome: "in_progress" },
      data: { outcome, finishedAt: at, errorCode: code, errorMessage: message },
    });
    if (classification === "retryable" && retryAllowed) {
      await tx.emailDelivery.updateMany({
        where: { id: attempt.deliveryId, status: "processing" },
        data: { status: "scheduled", sendStartedAt: null, failureCode: code, failureMessage: message },
      });
    } else if (classification === "permanent" || classification === "retryable") {
      await tx.emailDelivery.updateMany({
        where: { id: attempt.deliveryId, status: "processing" },
        data: {
          status: "failed",
          failureCode: classification === "retryable" ? "RETRY_LIMIT_REACHED" : code,
          failureMessage: classification === "retryable" ? "The bounded retry limit was reached after a temporary SMTP rejection." : message,
        },
      });
    } else if (classification === "unknown") {
      await tx.emailDelivery.updateMany({
        where: { id: attempt.deliveryId, status: "processing" },
        data: { status: "delivery_unknown", failureCode: code, failureMessage: "SMTP may have accepted the message; automatic resend was suppressed." },
      });
    }
  });
}

export async function settleExhaustedWorkerJob(prisma: PrismaClient, deliveryId: string, at = new Date()): Promise<"failed" | "delivery_unknown" | "unchanged"> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedDelivery[]>`
      SELECT id, status, user_id, campaign_id, send_started_at
      FROM email_deliveries
      WHERE id = ${deliveryId}::uuid
      FOR UPDATE
    `;
    const delivery = rows[0];
    if (!delivery || delivery.status !== "processing") return "unchanged";
    const latest = await tx.deliveryAttempt.findFirst({ where: { deliveryId }, orderBy: { attemptNumber: "desc" } });
    const uncertain = Boolean(delivery.send_started_at || latest?.smtpStartedAt);
    const terminalStatus = uncertain ? "delivery_unknown" : "failed";
    const errorCode = uncertain ? "SMTP_OUTCOME_UNKNOWN" : "WORKER_RETRY_LIMIT_REACHED";
    await tx.emailDelivery.updateMany({
      where: { id: deliveryId, status: "processing" },
      data: {
        status: terminalStatus,
        failureCode: errorCode,
        failureMessage: uncertain
          ? "The worker stopped after SMTP submission may have started; automatic resend was suppressed."
          : "The worker retry limit was reached before SMTP submission began.",
      },
    });
    if (latest?.outcome === "in_progress") {
      await tx.deliveryAttempt.update({
        where: { id: latest.id },
        data: {
          outcome: uncertain ? "delivery_unknown" : "permanent_failure",
          finishedAt: at,
          errorCode,
          errorMessage: uncertain ? "SMTP submission may have completed." : "Worker retries were exhausted before SMTP started.",
        },
      });
    }
    return terminalStatus;
  });
}

function acceptedAddress(item: string | { address: string }): string {
  return typeof item === "string" ? item : item.address;
}

function parseResponseCode(response: string | undefined): number | undefined {
  const match = response?.match(/^\s*(\d{3})/);
  return match ? Number(match[1]) : undefined;
}

function safeFailureFields(error: unknown): { smtpErrorCode?: string; smtpCommand?: string; smtpResponseCode?: number } {
  const candidate = error as { code?: unknown; command?: unknown; responseCode?: unknown } | null;
  return {
    ...(typeof candidate?.code === "string" ? { smtpErrorCode: candidate.code.slice(0, 100) } : {}),
    ...(typeof candidate?.command === "string" ? { smtpCommand: candidate.command.slice(0, 100) } : {}),
    ...(Number.isInteger(Number(candidate?.responseCode)) ? { smtpResponseCode: Number(candidate?.responseCode) } : {}),
  };
}

function safeFailureMessage(error: unknown): string {
  const fields = safeFailureFields(error);
  return [fields.smtpErrorCode, fields.smtpCommand, fields.smtpResponseCode].filter(Boolean).join(" ").slice(0, 500) || "SMTP send failed";
}
