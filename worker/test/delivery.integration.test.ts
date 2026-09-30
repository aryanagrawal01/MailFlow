import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { QueueEvents, Worker } from "bullmq";
import pino from "pino";
import {
  createDeliveryConnectionOptions,
  createDeliveryQueue,
  closeInfrastructureClients,
  createInfrastructureClients,
  DELIVERY_JOB_NAME,
  DELIVERY_QUEUE_NAME,
  loadServerEnvironment,
  type DeliveryJobData,
} from "@mailflow/shared";
import { createPrismaClient } from "@mailflow/api/db/client.js";
import { processDelivery, type EmailTransport } from "../src/delivery-processor.js";

const suffix = randomUUID();
const environment = loadServerEnvironment(process.env);
const prisma = createPrismaClient(environment.DATABASE_URL);
const queue = createDeliveryQueue(environment.REDIS_URL, { attempts: 2, retryDelayMs: 30 });
const events = new QueueEvents(DELIVERY_QUEUE_NAME, { connection: createDeliveryConnectionOptions(environment.REDIS_URL, null) });
const infrastructure = createInfrastructureClients(environment);
const log = pino({ enabled: false });
let userId = "";
let sendImplementation: EmailTransport["sendMail"] = async () => ({ messageId: "<test-message@example.test>", accepted: ["recipient@example.test"] });
let worker: Worker<DeliveryJobData, void, typeof DELIVERY_JOB_NAME>;
const insertedJobs: string[] = [];

before(async () => {
  const user = await prisma.user.create({ data: { googleSubject: `worker-test-${suffix}`, email: `worker-${suffix}@example.test`, name: "Worker Test" } });
  userId = user.id;
  await infrastructure.redis.connect();
  await events.waitUntilReady();
  worker = new Worker<DeliveryJobData, void, typeof DELIVERY_JOB_NAME>(
    DELIVERY_QUEUE_NAME,
    (job, token) => processDelivery(job, token, {
      prisma,
      redis: infrastructure.redis,
      transport: { sendMail: (message) => sendImplementation(message) },
      from: "worker-test@example.test",
      maxAttempts: 2,
      minimumSpacingMs: 10,
      senderHourlyLimit: 100,
      logger: log,
    }),
    { connection: createDeliveryConnectionOptions(environment.REDIS_URL, null), concurrency: 4, stalledInterval: 1_000 },
  );
  worker.on("error", () => undefined);
  await once(worker, "ready");
});

after(async () => {
  await worker.close();
  for (const jobId of insertedJobs) {
    const job = await queue.getJob(jobId);
    if (job) await job.remove();
  }
  await events.close();
  await queue.close();
  await prisma.user.deleteMany({ where: { id: userId || undefined } });
  await prisma.$disconnect();
  await closeInfrastructureClients(infrastructure);
});

test("worker claims once under concurrency, retries temporary errors, and terminalizes permanent/unknown outcomes", async () => {
  const concurrent = await createScheduledDelivery("concurrent");
  let sends = 0;
  sendImplementation = async () => {
    sends += 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { messageId: "<concurrent@example.test>", accepted: [concurrent.recipient] };
  };
  const concurrentJobA = uniqueId("parallel-a");
  const concurrentJobB = uniqueId("parallel-b");
  const jobA = await queue.add(DELIVERY_JOB_NAME, { deliveryId: concurrent.id }, { jobId: concurrentJobA, attempts: 2, removeOnComplete: false });
  const jobB = await queue.add(DELIVERY_JOB_NAME, { deliveryId: concurrent.id }, { jobId: concurrentJobB, attempts: 2, removeOnComplete: false });
  insertedJobs.push(concurrentJobA, concurrentJobB);
  await Promise.all([jobA.waitUntilFinished(events, 10_000), jobB.waitUntilFinished(events, 10_000)]);
  const concurrentState = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: concurrent.id } });
  assert.equal(sends, 1, "a competing queue job cannot take over the active database claim");
  assert.equal(concurrentState.status, "sent");
  assert.equal(await prisma.deliveryAttempt.count({ where: { deliveryId: concurrent.id } }), 1);

  const retryable = await createScheduledDelivery("temporary");
  let temporaryCalls = 0;
  sendImplementation = async () => {
    temporaryCalls += 1;
    if (temporaryCalls === 1) throw Object.assign(new Error("temporary SMTP response"), { responseCode: 421, command: "DATA" });
    return { messageId: "<retry@example.test>", accepted: [retryable.recipient] };
  };
  const retryJobId = uniqueId("retry");
  const retryJob = await queue.add(DELIVERY_JOB_NAME, { deliveryId: retryable.id }, {
    jobId: retryJobId,
    attempts: 2,
    backoff: { type: "fixed", delay: 30 },
    removeOnComplete: false,
  });
  insertedJobs.push(retryJobId);
  await retryJob.waitUntilFinished(events, 10_000);
  assert.equal(temporaryCalls, 2);
  assert.equal((await prisma.emailDelivery.findUniqueOrThrow({ where: { id: retryable.id } })).status, "sent");
  assert.deepEqual(
    (await prisma.deliveryAttempt.findMany({ where: { deliveryId: retryable.id }, orderBy: { attemptNumber: "asc" } })).map((attempt) => attempt.outcome),
    ["retryable_failure", "sent"],
  );

  const permanent = await createScheduledDelivery("permanent");
  sendImplementation = async () => { throw Object.assign(new Error("recipient rejected"), { responseCode: 550, command: "RCPT TO" }); };
  const permanentJobId = uniqueId("permanent");
  const permanentJob = await queue.add(DELIVERY_JOB_NAME, { deliveryId: permanent.id }, { jobId: permanentJobId, attempts: 2, removeOnComplete: false });
  insertedJobs.push(permanentJobId);
  await permanentJob.waitUntilFinished(events, 10_000);
  assert.equal((await prisma.emailDelivery.findUniqueOrThrow({ where: { id: permanent.id } })).status, "failed");
  assert.equal((await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryId: permanent.id } })).outcome, "permanent_failure");

  const unknown = await createScheduledDelivery("unknown");
  sendImplementation = async () => { throw Object.assign(new Error("socket lost after DATA"), { code: "ESOCKET", command: "DATA" }); };
  const unknownJobId = uniqueId("unknown");
  const unknownJob = await queue.add(DELIVERY_JOB_NAME, { deliveryId: unknown.id }, { jobId: unknownJobId, attempts: 2, removeOnComplete: false });
  insertedJobs.push(unknownJobId);
  await unknownJob.waitUntilFinished(events, 10_000);
  assert.equal((await prisma.emailDelivery.findUniqueOrThrow({ where: { id: unknown.id } })).status, "delivery_unknown");
  assert.equal(await prisma.deliveryAttempt.count({ where: { deliveryId: unknown.id } }), 1, "unknown SMTP result is not automatically resent");
});

test("a redelivered job recovers a pre-SMTP crash but suppresses resend after the SMTP boundary", async () => {
  const beforeSmtp = await createScheduledDelivery("crash-safe");
  const deterministicId = `delivery-${beforeSmtp.id}`;
  await prisma.emailDelivery.update({ where: { id: beforeSmtp.id }, data: { status: "processing" } });
  await prisma.deliveryAttempt.create({
    data: { userId, deliveryId: beforeSmtp.id, queueJobId: deterministicId, attemptNumber: 1, outcome: "in_progress" },
  });
  let safeSends = 0;
  sendImplementation = async () => { safeSends += 1; return { messageId: "<recovered@example.test>", accepted: [beforeSmtp.recipient] }; };
  const recoveryJob = await queue.add(DELIVERY_JOB_NAME, { deliveryId: beforeSmtp.id }, { jobId: deterministicId, removeOnComplete: false });
  insertedJobs.push(deterministicId);
  await recoveryJob.waitUntilFinished(events, 10_000);
  assert.equal(safeSends, 1);
  assert.equal((await prisma.emailDelivery.findUniqueOrThrow({ where: { id: beforeSmtp.id } })).status, "sent");
  assert.equal((await prisma.deliveryAttempt.count({ where: { deliveryId: beforeSmtp.id } })), 2);

  const afterSmtp = await createScheduledDelivery("crash-unknown");
  const uncertainJobId = `delivery-${afterSmtp.id}`;
  await prisma.emailDelivery.update({ where: { id: afterSmtp.id }, data: { status: "processing", sendStartedAt: new Date() } });
  await prisma.deliveryAttempt.create({
    data: {
      userId,
      deliveryId: afterSmtp.id,
      queueJobId: uncertainJobId,
      attemptNumber: 1,
      outcome: "in_progress",
      smtpStartedAt: new Date(),
    },
  });
  let uncertainSends = 0;
  sendImplementation = async () => { uncertainSends += 1; return { accepted: [afterSmtp.recipient] }; };
  const uncertainJob = await queue.add(DELIVERY_JOB_NAME, { deliveryId: afterSmtp.id }, { jobId: uncertainJobId, removeOnComplete: false });
  insertedJobs.push(uncertainJobId);
  await uncertainJob.waitUntilFinished(events, 10_000);
  assert.equal(uncertainSends, 0);
  assert.equal((await prisma.emailDelivery.findUniqueOrThrow({ where: { id: afterSmtp.id } })).status, "delivery_unknown");
});

async function createScheduledDelivery(label: string): Promise<{ id: string; recipient: string }> {
  const campaign = await prisma.campaign.create({
    data: {
      userId,
      subject: `Worker ${label}`,
      body: "Shared body used only in the test.",
      requestedStartAt: new Date(Date.now() + 5_000),
      delayMs: 2_000,
      hourlyLimit: 10,
      recipientCount: 1,
    },
  });
  const recipient = `${label}-${randomUUID()}@example.test`;
  const delivery = await prisma.emailDelivery.create({
    data: {
      userId,
      campaignId: campaign.id,
      recipientEmail: recipient,
      normalizedRecipient: recipient.toLowerCase(),
      recipientPosition: 0,
      scheduledAt: new Date(),
    },
  });
  return { id: delivery.id, recipient };
}

function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
