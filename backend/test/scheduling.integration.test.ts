import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import pino from "pino";
import {
  closeInfrastructureClients,
  createDeliveryQueue,
  createInfrastructureClients,
  DeliveryQueueHandoff,
  loadServerEnvironment,
} from "@mailflow/shared";
import { createApplicationSession } from "../src/auth/session.js";
import { createApp } from "../src/app.js";
import { createOutboxHandoffStore } from "../src/queues/outbox-store.js";
import { createCampaignSchedule } from "../src/campaigns/scheduling.js";
import { createPrismaClient } from "../src/db/client.js";

const suffix = randomUUID();
const environment = loadServerEnvironment(process.env);
const prisma = createPrismaClient(environment.DATABASE_URL);
const infrastructure = createInfrastructureClients(environment);
let queue = createDeliveryQueue(environment.REDIS_URL);
let ownerId = "";
let otherUserId = "";
let ownerToken = "";
let otherToken = "";
let handoff: DeliveryQueueHandoff;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let baseUrl = "";
const jobIds: string[] = [];
let recoveredCampaignId = "";

before(async () => {
  const owner = await prisma.user.create({
    data: { googleSubject: `schedule-owner-${suffix}`, email: `schedule-owner-${suffix}@example.test`, name: "Scheduler" },
  });
  const other = await prisma.user.create({
    data: { googleSubject: `schedule-other-${suffix}`, email: `schedule-other-${suffix}@example.test`, name: "Other" },
  });
  ownerId = owner.id;
  otherUserId = other.id;
  ownerToken = (await createApplicationSession(prisma, ownerId, 1)).token;
  otherToken = (await createApplicationSession(prisma, otherUserId, 1)).token;

  // Simulate a process crash after the one DB transaction commits but before
  // the process creates or records any BullMQ jobs.
  const startAt = new Date(Date.now() + 10 * 60_000);
  const recovered = await createCampaignSchedule(prisma, ownerId, {
    subject: "Recover handoff",
    body: "Durable schedule test",
    recipients: [`recover-${suffix}@example.test`],
    startAt,
    delayMs: environment.MIN_DELAY_MS,
    hourlyLimit: 5,
  });
  recoveredCampaignId = recovered.campaign.id;
  const recoveredJobId = recovered.deliveries[0]!.jobId;
  jobIds.push(recoveredJobId);
  assert.equal(await queue.getJob(recoveredJobId), undefined);

  handoff = new DeliveryQueueHandoff(queue, createOutboxHandoffStore(prisma), pino({ enabled: false }));
  await handoff.start();

  const app = createApp(pino({ enabled: false }), environment, infrastructure, { prisma, handoff });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  for (const jobId of jobIds) {
    const job = await queue.getJob(jobId);
    if (job) await job.remove();
  }
  await handoff.close();
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherUserId].filter(Boolean) } } });
  await prisma.$disconnect();
  await closeInfrastructureClients(infrastructure);
});

test("scheduling transaction, delayed queue handoff, deduplication, pagination, and ownership", async () => {
  const request = {
    subject: "Welcome",
    body: "One body shared by every recipient.",
    recipients: [
      ` First-${suffix}@Example.Test `,
      `first-${suffix}@example.test`,
      `second-${suffix}@Example.Test`,
    ],
    startAt: new Date(Date.now() + 12 * 60_000).toISOString(),
    delayMs: environment.MIN_DELAY_MS,
    hourlyLimit: 10,
  };

  const scheduledResponse = await fetch(`${baseUrl}/api/campaigns`, {
    method: "POST",
    headers: { cookie: sessionCookie(ownerToken), "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  assert.equal(scheduledResponse.status, 201, await scheduledResponse.clone().text());
  const result = await scheduledResponse.json() as {
    campaign: { id: string; recipientCount: number };
    deliveries: Array<{ id: string; recipientEmail: string; scheduledAt: string }>;
    queueHandoff: { enqueued: number };
  };
  assert.equal(result.campaign.recipientCount, 2, "case/space variants deduplicate to one recipient");
  assert.equal(result.deliveries.length, 2);
  assert.equal(result.deliveries[0]!.recipientEmail, `First-${suffix}@Example.Test`);
  assert.equal(result.deliveries[0]!.scheduledAt, request.startAt);
  assert.equal(new Date(result.deliveries[1]!.scheduledAt).getTime(), new Date(request.startAt).getTime() + request.delayMs);
  assert.equal(result.queueHandoff.enqueued, 2, "both unique campaign deliveries were handed to the queue");

  const databaseDeliveries = await prisma.emailDelivery.findMany({
    where: { campaignId: result.campaign.id, userId: ownerId },
    orderBy: { recipientPosition: "asc" },
  });
  assert.deepEqual(databaseDeliveries.map((delivery) => delivery.normalizedRecipient), [
    `first-${suffix}@example.test`,
    `second-${suffix}@example.test`,
  ]);
  assert.deepEqual(databaseDeliveries.map((delivery) => delivery.scheduledAt.toISOString()), [
    request.startAt,
    new Date(new Date(request.startAt).getTime() + request.delayMs).toISOString(),
  ]);

  const recoveredDelivery = await prisma.emailDelivery.findFirstOrThrow({ where: { campaignId: recoveredCampaignId, userId: ownerId } });
  const recoveredJobId = `delivery-${recoveredDelivery.id}`;
  assert.ok(await queue.getJob(recoveredJobId), "startup reconciliation created the job from its committed outbox row");
  await prisma.queueOutbox.update({ where: { deliveryId: recoveredDelivery.id }, data: { state: "pending", enqueuedAt: null } });
  const retriedHandoff = await handoff.reconcile("duplicate-handoff-test");
  assert.equal(retriedHandoff.enqueued, 1);
  assert.equal((await queue.getJob(recoveredJobId))?.id, recoveredJobId, "same deterministic job ID resolves to one queue record");

  for (const delivery of databaseDeliveries) jobIds.push(`delivery-${delivery.id}`);
  const outboxStates = await prisma.queueOutbox.findMany({
    where: { campaignId: result.campaign.id, userId: ownerId },
    select: { state: true },
  });
  assert.ok(outboxStates.every((row) => row.state === "enqueued"));

  const page1 = await fetch(`${baseUrl}/api/campaigns?page=1&pageSize=1`, { headers: { cookie: sessionCookie(ownerToken) } });
  const campaignPage1 = await page1.json() as { items: Array<{ id: string }>; total: number; page: number; pageSize: number };
  const page2 = await fetch(`${baseUrl}/api/campaigns?page=2&pageSize=1`, { headers: { cookie: sessionCookie(ownerToken) } });
  const campaignPage2 = await page2.json() as { items: Array<{ id: string }>; total: number; page: number; pageSize: number };
  assert.equal(campaignPage1.total, 2);
  assert.equal(campaignPage1.items.length, 1);
  assert.equal(campaignPage2.items.length, 1);
  assert.notEqual(campaignPage1.items[0]!.id, campaignPage2.items[0]!.id);

  const deliveryPage1 = await fetch(
    `${baseUrl}/api/campaigns/${result.campaign.id}/deliveries?page=1&pageSize=1`,
    { headers: { cookie: sessionCookie(ownerToken) } },
  );
  const deliveryList1 = await deliveryPage1.json() as { items: Array<{ id: string }>; total: number };
  const deliveryPage2 = await fetch(
    `${baseUrl}/api/campaigns/${result.campaign.id}/deliveries?page=2&pageSize=1`,
    { headers: { cookie: sessionCookie(ownerToken) } },
  );
  const deliveryList2 = await deliveryPage2.json() as { items: Array<{ id: string }>; total: number };
  assert.equal(deliveryList1.total, 2);
  assert.equal(deliveryList1.items.length, 1);
  assert.equal(deliveryList2.items.length, 1);
  assert.notEqual(deliveryList1.items[0]!.id, deliveryList2.items[0]!.id);

  const ownedDeliveries = await fetch(
    `${baseUrl}/api/deliveries?campaignId=${result.campaign.id}&page=1&pageSize=1`,
    { headers: { cookie: sessionCookie(ownerToken) } },
  );
  assert.equal((await ownedDeliveries.json() as { total: number }).total, 2);

  const otherCampaigns = await fetch(`${baseUrl}/api/campaigns`, { headers: { cookie: sessionCookie(otherToken) } });
  assert.equal((await otherCampaigns.json() as { total: number }).total, 0);
  const crossUserDeliveries = await fetch(
    `${baseUrl}/api/campaigns/${result.campaign.id}/deliveries`,
    { headers: { cookie: sessionCookie(otherToken) } },
  );
  assert.equal(crossUserDeliveries.status, 404);

  const invalidSchedules = [
    { ...request, subject: "   " },
    { ...request, body: "  " },
    { ...request, recipients: ["not-an-email"] },
    { ...request, recipients: [] },
    { ...request, startAt: "not-a-date" },
    { ...request, startAt: new Date(Date.now() - 1_000).toISOString() },
    { ...request, delayMs: environment.MIN_DELAY_MS - 1 },
    { ...request, hourlyLimit: environment.MAX_EMAILS_PER_HOUR_PER_SENDER + 1 },
  ];
  for (const invalidSchedule of invalidSchedules) {
    const invalidResponse = await fetch(`${baseUrl}/api/campaigns`, {
      method: "POST",
      headers: { cookie: sessionCookie(ownerToken), "content-type": "application/json" },
      body: JSON.stringify(invalidSchedule),
    });
    assert.equal(invalidResponse.status, 400);
  }
});

function sessionCookie(token: string): string {
  return `${environment.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}
