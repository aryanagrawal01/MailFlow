import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { EmailDeliveryStatus } from "../src/generated/prisma/enums.js";
import { createPrismaClient } from "../src/db/client.js";
import {
  findOwnedCampaign,
  findOwnedDelivery,
  isValidDeliveryStatusTransition,
  listOwnedDeliveries,
  transitionOwnedDeliveryStatus,
} from "../src/db/ownership.js";

const prisma = createPrismaClient();
const suffix = randomUUID();
let ownerId = "";
let otherUserId = "";
let campaignId = "";
let deliveryId = "";

before(async () => {
  const owner = await prisma.user.create({
    data: { googleSubject: `phase2-${suffix}`, email: `owner-${suffix}@example.test`, name: "Owner" },
  });
  const other = await prisma.user.create({
    data: { googleSubject: `phase2-other-${suffix}`, email: `other-${suffix}@example.test`, name: "Other" },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: owner.id,
      subject: "Phase 2 database check",
      body: "Integration test only",
      requestedStartAt: new Date(),
      delayMs: 2_000,
      hourlyLimit: 20,
      recipientCount: 1,
    },
  });
  const delivery = await prisma.emailDelivery.create({
    data: {
      userId: owner.id,
      campaignId: campaign.id,
      recipientEmail: `Contact-${suffix}@example.test`,
      normalizedRecipient: `contact-${suffix}@example.test`,
      recipientPosition: 0,
      scheduledAt: new Date(),
    },
  });

  ownerId = owner.id;
  otherUserId = other.id;
  campaignId = campaign.id;
  deliveryId = delivery.id;
});

after(async () => {
  if (ownerId || otherUserId) {
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherUserId].filter(Boolean) } } });
  }
  await prisma.$disconnect();
});

test("Phase 2 constraints, ownership-scoped access, and delivery status transitions", async () => {
  const duplicateCreate = prisma.emailDelivery.create({
    data: {
      userId: ownerId,
      campaignId,
      recipientEmail: `contact-${suffix}@example.test`,
      normalizedRecipient: `contact-${suffix}@example.test`,
      recipientPosition: 1,
      scheduledAt: new Date(),
    },
  });
  await assert.rejects(duplicateCreate, (error: unknown) => {
    return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
  }, "same campaign plus normalized recipient should be unique");

  assert.equal((await findOwnedCampaign(prisma, ownerId, campaignId))?.id, campaignId);
  assert.equal(await findOwnedCampaign(prisma, otherUserId, campaignId), null);
  assert.equal((await findOwnedDelivery(prisma, ownerId, deliveryId))?.id, deliveryId);
  assert.equal(await findOwnedDelivery(prisma, otherUserId, deliveryId), null);
  assert.deepEqual(await listOwnedDeliveries(prisma, otherUserId), []);
  await assert.rejects(
    prisma.emailDelivery.create({
      data: {
        userId: otherUserId,
        campaignId,
        recipientEmail: `cross-owner-${suffix}@example.test`,
        normalizedRecipient: `cross-owner-${suffix}@example.test`,
        recipientPosition: 2,
        scheduledAt: new Date(),
      },
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2003",
    "database composite ownership foreign key rejects cross-user campaign attachment",
  );

  const utcHour = new Date();
  utcHour.setUTCMinutes(0, 0, 0);
  await prisma.slackAlert.create({ data: { userId: ownerId, hourWindowStart: utcHour } });
  await assert.rejects(
    prisma.slackAlert.create({ data: { userId: ownerId, hourWindowStart: utcHour } }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002",
    "one user can have only one Slack alert for a UTC hour",
  );
  const offHour = new Date(utcHour.getTime() + 60_000);
  await assert.rejects(
    prisma.slackAlert.create({ data: { userId: ownerId, hourWindowStart: offHour } }),
    (error: unknown) => error instanceof Error && error.message.includes("slack_alerts_hour_window_start_utc_hour_check"),
    "Slack alert bucket must start at a UTC hour boundary",
  );

  assert.equal(
    await transitionOwnedDeliveryStatus(
      prisma,
      otherUserId,
      deliveryId,
      EmailDeliveryStatus.scheduled,
      EmailDeliveryStatus.processing,
    ),
    false,
    "a different user cannot transition the delivery",
  );
  assert.equal(
    await transitionOwnedDeliveryStatus(
      prisma,
      ownerId,
      deliveryId,
      EmailDeliveryStatus.scheduled,
      EmailDeliveryStatus.processing,
    ),
    true,
  );
  assert.equal(isValidDeliveryStatusTransition(EmailDeliveryStatus.processing, EmailDeliveryStatus.delivery_unknown), true);
  assert.equal(isValidDeliveryStatusTransition(EmailDeliveryStatus.sent, EmailDeliveryStatus.scheduled), false);
  await assert.rejects(
    transitionOwnedDeliveryStatus(
      prisma,
      ownerId,
      deliveryId,
      EmailDeliveryStatus.sent,
      EmailDeliveryStatus.scheduled,
    ),
    /Invalid email delivery status transition/,
  );
});
