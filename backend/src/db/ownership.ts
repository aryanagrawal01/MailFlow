import type { PrismaClient } from "../generated/prisma/client.js";
import { EmailDeliveryStatus } from "../generated/prisma/enums.js";

type OwnershipReader = Pick<PrismaClient, "campaign" | "emailDelivery" | "slackConnection">;
type DeliveryStatusWriter = Pick<PrismaClient, "emailDelivery">;

export function findOwnedCampaign(prisma: OwnershipReader, userId: string, campaignId: string) {
  return prisma.campaign.findFirst({ where: { id: campaignId, userId } });
}

export function findOwnedDelivery(prisma: OwnershipReader, userId: string, deliveryId: string) {
  return prisma.emailDelivery.findFirst({ where: { id: deliveryId, userId } });
}

export function listOwnedDeliveries(prisma: OwnershipReader, userId: string) {
  return prisma.emailDelivery.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}

export function findOwnedSlackConnection(prisma: OwnershipReader, userId: string) {
  return prisma.slackConnection.findUnique({ where: { userId } });
}

const allowedTransitions: Record<EmailDeliveryStatus, readonly EmailDeliveryStatus[]> = {
  [EmailDeliveryStatus.scheduled]: [EmailDeliveryStatus.processing, EmailDeliveryStatus.failed],
  [EmailDeliveryStatus.processing]: [
    EmailDeliveryStatus.scheduled,
    EmailDeliveryStatus.sent,
    EmailDeliveryStatus.failed,
    EmailDeliveryStatus.delivery_unknown,
  ],
  [EmailDeliveryStatus.sent]: [],
  [EmailDeliveryStatus.failed]: [],
  [EmailDeliveryStatus.delivery_unknown]: [],
};

export class InvalidDeliveryStatusTransitionError extends Error {
  constructor(from: EmailDeliveryStatus, to: EmailDeliveryStatus) {
    super(`Invalid email delivery status transition: ${from} -> ${to}`);
    this.name = "InvalidDeliveryStatusTransitionError";
  }
}

export function isValidDeliveryStatusTransition(from: EmailDeliveryStatus, to: EmailDeliveryStatus): boolean {
  return allowedTransitions[from].includes(to);
}

/** Updates only when both the owner and expected current state match. */
export async function transitionOwnedDeliveryStatus(
  prisma: DeliveryStatusWriter,
  userId: string,
  deliveryId: string,
  from: EmailDeliveryStatus,
  to: EmailDeliveryStatus,
): Promise<boolean> {
  if (!isValidDeliveryStatusTransition(from, to)) {
    throw new InvalidDeliveryStatusTransitionError(from, to);
  }

  const result = await prisma.emailDelivery.updateMany({
    where: { id: deliveryId, userId, status: from },
    data: { status: to },
  });
  return result.count === 1;
}
