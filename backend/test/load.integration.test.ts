import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pino from "pino";
import {
  closeInfrastructureClients,
  createDeliveryQueue,
  createInfrastructureClients,
  loadServerEnvironment,
  type DeliveryJobData,
} from "@mailflow/shared";
import type { Queue } from "bullmq";
import { createApplicationSession } from "../src/auth/session.js";
import { createApp } from "../src/app.js";
import { createOutboxHandoffStore } from "../src/queues/outbox-store.js";
import { createPrismaClient } from "../src/db/client.js";
import { DeliveryQueueHandoff } from "@mailflow/shared";

const environment = loadServerEnvironment(process.env);
const prisma = createPrismaClient(environment.DATABASE_URL);
const infrastructure = createInfrastructureClients(environment);
const queue: Queue<DeliveryJobData> = createDeliveryQueue(environment.REDIS_URL);
const logger = pino({ enabled: false });
const suffix = randomUUID();
const recipientCount = 1_000;
let userId = "";
let cookie = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let baseUrl = "";
let handoff: DeliveryQueueHandoff;

before(async () => {
  const user = await prisma.user.create({ data: {
    googleSubject: `load-test-${suffix}`,
    email: `load-${suffix}@example.test`,
    name: "Isolated load test",
  } });
  userId = user.id;
  cookie = `${environment.SESSION_COOKIE_NAME}=${encodeURIComponent((await createApplicationSession(prisma, userId, 1)).token)}`;
  handoff = new DeliveryQueueHandoff(queue, createOutboxHandoffStore(prisma), logger);
  await handoff.start();
  const app = createApp(logger, environment, infrastructure, { prisma, handoff });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) { server.close(); await once(server, "close"); }
  if (userId) {
    const ownDeliveries = await prisma.emailDelivery.findMany({ where: { userId }, select: { id: true } });
    for (const delivery of ownDeliveries) {
      const job = await queue.getJob(`delivery-${delivery.id}`);
      await job?.remove().catch(() => undefined);
    }
    // Isolated ownership makes cascading cleanup safe; shared queue records were removed above.
    await prisma.user.delete({ where: { id: userId } });
  }
  await handoff?.close();
  await queue.close();
  await prisma.$disconnect();
  await closeInfrastructureClients(infrastructure);
});

test("1,000-recipient campaign persists every accepted delivery and hands off every job", async (t) => {
  const recipients = Array.from({ length: recipientCount }, (_, index) => `load-${suffix}-${index}@example.test`);
  const submitted = [...recipients, recipients[5]!.toUpperCase(), `  ${recipients[999]}  `];
  const startAt = new Date(Date.now() + 60 * 60_000);
  const delayMs = Math.max(environment.MIN_DELAY_MS, 1_000);
  const request = {
    subject: `Load campaign ${suffix}`,
    body: "A shared test body. This test never starts an SMTP worker.",
    recipients: submitted,
    startAt: startAt.toISOString(),
    delayMs,
    hourlyLimit: Math.min(100, environment.MAX_EMAILS_PER_HOUR_PER_SENDER),
  };

  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/campaigns`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const elapsedMs = performance.now() - startedAt;
  const result = await response.json() as {
    campaign: { id: string; recipientCount: number };
    deliveries: Array<{ id: string; recipientEmail: string; scheduledAt: string }>;
    queueHandoff: { attempted: number; enqueued: number; failedBatches: number };
  };
  assert.equal(result.campaign.recipientCount, recipientCount, "case/whitespace duplicates are normalized and removed");
  assert.equal(result.deliveries.length, recipientCount);
  assert.equal(result.queueHandoff.attempted, recipientCount);
  assert.equal(result.queueHandoff.enqueued, recipientCount);
  assert.equal(result.queueHandoff.failedBatches, 0);

  const dbStartedAt = performance.now();
  const [deliveryRows, outboxRows] = await Promise.all([
    prisma.emailDelivery.findMany({ where: { userId, campaignId: result.campaign.id }, orderBy: { recipientPosition: "asc" } }),
    prisma.queueOutbox.findMany({ where: { userId, campaignId: result.campaign.id } }),
  ]);
  const databaseCountMs = performance.now() - dbStartedAt;
  assert.equal(deliveryRows.length, recipientCount);
  assert.equal(outboxRows.length, recipientCount);
  assert.ok(outboxRows.every((row) => row.state === "enqueued"));
  assert.equal(deliveryRows[0]!.scheduledAt.getTime(), startAt.getTime());
  assert.equal(deliveryRows.at(-1)!.scheduledAt.getTime(), startAt.getTime() + (recipientCount - 1) * delayMs);
  assert.ok(deliveryRows.every((row, index) => row.recipientPosition === index));

  const queueStartedAt = performance.now();
  const queuedJobs = await Promise.all(deliveryRows.map((row) => queue.getJob(`delivery-${row.id}`)));
  const queueCountMs = performance.now() - queueStartedAt;
  assert.equal(queuedJobs.filter(Boolean).length, recipientCount, "every committed delivery has its deterministic BullMQ job");
  assert.equal(new Set(queuedJobs.map((job) => job?.id)).size, recipientCount);
  assert.ok(queuedJobs.every((job) => job?.data.deliveryId && job.data.deliveryId.length > 0));
  assert.ok(queuedJobs.every((job) => job?.data && Object.keys(job.data).length === 1), "queue payloads expose only delivery IDs");

  const duplicateHandoff = await handoff.reconcile("load-test-replay");
  assert.equal(duplicateHandoff.attempted, 0, "replaying a completed outbox scan does not add duplicate work");
  assert.equal((await queue.getJobs(["waiting", "delayed", "active"], 0, recipientCount + 10, false))
    .filter((job) => deliveryRows.some((row) => job.id === `delivery-${row.id}`)).length, recipientCount);

  const invalid = await fetch(`${baseUrl}/api/campaigns`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ...request, recipients: [recipients[0], "not-an-email"] }),
  });
  assert.equal(invalid.status, 400, "invalid recipient causes the request to be rejected according to Phase 4 API behavior");
  const campaignsAfterInvalid = await prisma.campaign.count({ where: { userId, subject: request.subject } });
  assert.equal(campaignsAfterInvalid, 1, "invalid requests do not partially persist a campaign");

  t.diagnostic(JSON.stringify({
    recipientsSubmitted: submitted.length,
    recipientsAccepted: result.campaign.recipientCount,
    duplicateRecipientsRemoved: submitted.length - result.campaign.recipientCount,
    invalidRequestStatus: invalid.status,
    deliveryRows: deliveryRows.length,
    queueOutboxRows: outboxRows.length,
    bullMqJobs: queuedJobs.filter(Boolean).length,
    handoff: result.queueHandoff,
    delayMs,
    workerConcurrency: "not started: safety boundary prevents external SMTP sends",
    schedulingApiElapsedMs: Number(elapsedMs.toFixed(2)),
    databaseCountQueryElapsedMs: Number(databaseCountMs.toFixed(2)),
    queueLookupElapsedMs: Number(queueCountMs.toFixed(2)),
    totalTestElapsedMs: Number((performance.now() - startedAt).toFixed(2)),
  }));
});
