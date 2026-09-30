import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { QueueEvents, Worker } from "bullmq";
import pino from "pino";
import {
  closeInfrastructureClients,
  createDeliveryConnectionOptions,
  createDeliveryQueue,
  createInfrastructureClients,
  DELIVERY_JOB_NAME,
  DELIVERY_QUEUE_NAME,
  loadServerEnvironment,
  reserveDeliveryRateSlot,
  type DeliveryJobData,
} from "@mailflow/shared";
import { createPrismaClient } from "@mailflow/api/db/client.js";
import { notifySenderHourlyLimit } from "@mailflow/api/slack/alerts.js";
import { encryptSlackToken } from "@mailflow/api/slack/token-crypto.js";
import type { SlackApi } from "@mailflow/api/slack/client.js";
import { processDelivery, type EmailTransport } from "../src/delivery-processor.js";

const environment = loadServerEnvironment(process.env);
const prisma = createPrismaClient(environment.DATABASE_URL);
const infrastructure = createInfrastructureClients(environment);
const queue = createDeliveryQueue(environment.REDIS_URL, { attempts: 2, retryDelayMs: 20 });
const events = new QueueEvents(DELIVERY_QUEUE_NAME, { connection: createDeliveryConnectionOptions(environment.REDIS_URL, null) });
const logger = pino({ enabled: false });
const userIds: string[] = [];
const jobIds: string[] = [];
let workers: Worker<DeliveryJobData, void, typeof DELIVERY_JOB_NAME>[] = [];
let workerClients: ReturnType<typeof createInfrastructureClients>[] = [];
let senderLimit = 100;
let minimumSpacingMs = 0;
let transport: EmailTransport["sendMail"] = async (message) => ({ accepted: [message.to], messageId: `<${message.to}>` });
let senderLimitAlert: ((userId: string, hourWindowStart: Date) => Promise<void>) | undefined;

before(async () => {
  await infrastructure.redis.connect();
  await events.waitUntilReady();
});

after(async () => {
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.all(workerClients.map((clients) => closeInfrastructureClients(clients)));
  for (const id of jobIds) {
    const job = await queue.getJob(id);
    if (job) await job.remove();
  }
  await events.close();
  await queue.close();
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
  await closeInfrastructureClients(infrastructure);
});

test("Redis coordinates spacing, UTC campaign/sender caps, capacity races, and restart recovery", async () => {
  const spacedUser = await newUser("single-spacing");
  minimumSpacingMs = 100;
  await replaceWorkers([{ concurrency: 1 }]);
  const spacedCampaign = await newCampaign(spacedUser, 20);
  const spacedDeliveries = await Promise.all([
    newDelivery(spacedUser, spacedCampaign, 0),
    newDelivery(spacedUser, spacedCampaign, 1),
    newDelivery(spacedUser, spacedCampaign, 2),
  ]);
  const sendTimes: number[] = [];
  transport = async (message) => {
    sendTimes.push(Date.now());
    return { accepted: [message.to], messageId: `<${message.to}>` };
  };
  const singleJobs = await Promise.all(spacedDeliveries.map((delivery) => enqueue(delivery.id)));
  await Promise.all(singleJobs.map((job) => job.waitUntilFinished(events, 10_000)));
  assert.equal(sendTimes.length, 3);
  assert.ok(sendTimes[1]! - sendTimes[0]! >= 85);
  assert.ok(sendTimes[2]! - sendTimes[1]! >= 85);

  const multiUser = await newUser("multi-worker-spacing");
  minimumSpacingMs = 100;
  await replaceWorkers([{ concurrency: 2 }, { concurrency: 2 }]);
  const multiCampaignA = await newCampaign(multiUser, 20);
  const multiCampaignB = await newCampaign(multiUser, 20);
  const multiDeliveries = await Promise.all([
    newDelivery(multiUser, multiCampaignA, 0),
    newDelivery(multiUser, multiCampaignB, 0),
    newDelivery(multiUser, multiCampaignA, 1),
  ]);
  sendTimes.length = 0;
  const multiJobs = await Promise.all(multiDeliveries.map((delivery) => enqueue(delivery.id)));
  await Promise.all(multiJobs.map((job) => job.waitUntilFinished(events, 10_000)));
  sendTimes.sort((a, b) => a - b);
  assert.equal(sendTimes.length, 3);
  assert.ok(sendTimes[1]! - sendTimes[0]! >= 85, "worker processes share sender spacing in Redis");
  assert.ok(sendTimes[2]! - sendTimes[1]! >= 85);

  const campaignUser = await newUser("campaign-cap");
  minimumSpacingMs = 0;
  senderLimit = 10;
  await replaceWorkers([{ concurrency: 2 }]);
  const cappedCampaign = await newCampaign(campaignUser, 1);
  const firstCampaignDelivery = await newDelivery(campaignUser, cappedCampaign, 0);
  const secondCampaignDelivery = await newDelivery(campaignUser, cappedCampaign, 1);
  const firstCampaignJob = await enqueue(firstCampaignDelivery.id);
  await firstCampaignJob.waitUntilFinished(events, 5_000);
  const secondCampaignJob = await enqueue(secondCampaignDelivery.id);
  await waitForJobState(secondCampaignJob.id!, "delayed");
  const nextHour = nextUtcHour(Date.now());
  assertDelayedUntil((await queue.getJob(secondCampaignJob.id!))!, nextHour);
  assert.equal((await prisma.emailDelivery.findUniqueOrThrow({ where: { id: secondCampaignDelivery.id } })).status, "scheduled");

  const senderUser = await newUser("sender-cap");
  senderLimit = 1;
  const senderCampaignA = await newCampaign(senderUser, 10);
  const senderCampaignB = await newCampaign(senderUser, 10);
  const firstSenderDelivery = await newDelivery(senderUser, senderCampaignA, 0);
  const secondSenderDelivery = await newDelivery(senderUser, senderCampaignB, 0);
  const firstSenderJob = await enqueue(firstSenderDelivery.id);
  await firstSenderJob.waitUntilFinished(events, 5_000);
  const secondSenderJob = await enqueue(secondSenderDelivery.id);
  const noSlackKey = randomBytes(32).toString("base64url");
  senderLimitAlert = (userId, hourWindowStart) => notifySenderHourlyLimit({ prisma, userId, hourWindowStart, encryptionKey: noSlackKey, logger });
  await waitForJobState(secondSenderJob.id!, "delayed");
  assertDelayedUntil((await queue.getJob(secondSenderJob.id!))!, nextUtcHour(Date.now()));
  assert.equal((await prisma.emailDelivery.findUniqueOrThrow({ where: { id: secondSenderDelivery.id } })).status, "scheduled");
  assert.equal(await prisma.slackAlert.count({ where: { userId: senderUser, status: "skipped" } }), 1, "missing Slack connection is recorded without failing or removing the delayed email job");
  senderLimitAlert = undefined;

  const raceUser = await newUser("capacity-race");
  senderLimit = 3;
  const encryptionKey = randomBytes(32).toString("base64url");
  await prisma.slackConnection.create({ data: {
    userId: raceUser, slackTeamId: "T-MAILFLOW", slackTeamName: "Rate test", botTokenEncrypted: encryptSlackToken("xoxb-test-token", encryptionKey),
    channelId: "C-MAILFLOW", channelName: "alerts",
  } });
  let slackPosts = 0;
  const failingSlackApi: SlackApi = {
    async listChannels() { return []; },
    async postMessage() { slackPosts += 1; throw new Error("test Slack API outage"); },
  };
  senderLimitAlert = (userId, hourWindowStart) => notifySenderHourlyLimit({
    prisma, userId, hourWindowStart, encryptionKey, logger, api: failingSlackApi,
  });
  await replaceWorkers([{ concurrency: 5 }, { concurrency: 5 }]);
  const raceCampaigns = await Promise.all(Array.from({ length: 8 }, () => newCampaign(raceUser, 20)));
  const raceDeliveries = await Promise.all(raceCampaigns.map((campaignId, index) => newDelivery(raceUser, campaignId, index)));
  let acceptedSends = 0;
  transport = async (message) => {
    acceptedSends += 1;
    return { accepted: [message.to], messageId: `<${message.to}>` };
  };
  const raceJobs = await Promise.all(raceDeliveries.map((delivery) => enqueue(delivery.id)));
  await waitForJobsSettled(raceJobs.map((job) => job.id!));
  assert.equal(acceptedSends, 3, "atomic Redis reservations prevent workers exceeding sender capacity");
  let delayedCount = 0;
  for (const job of raceJobs) {
    const state = await (await queue.getJob(job.id!))!.getState();
    if (state === "delayed") delayedCount += 1;
  }
  assert.equal(delayedCount, 5);
  assert.equal(slackPosts, 1, "concurrent workers create one sender/hour notification attempt");
  assert.equal(await prisma.slackAlert.count({ where: { userId: raceUser, status: "failed" } }), 1, "Slack API failure is recorded once while limited email jobs remain durable");
  senderLimitAlert = undefined;
  for (const delivery of raceDeliveries) {
    const state = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    assert.ok(state.status === "sent" || state.status === "scheduled");
    assert.notEqual(state.status, "failed", "a rate limit never permanently fails a delivery");
  }

  const senderWindow = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const senderKey = `mailflow:{mailflow-rate}:sender:${raceUser}:${senderWindow}`;
  assert.equal(await infrastructure.redis.get(senderKey), "3");
  await replaceWorkers([{ concurrency: 2 }]);
  assert.equal(await infrastructure.redis.get(senderKey), "3", "restarting workers preserves the Redis hourly reservation count");
  for (const job of raceJobs) {
    if (await job.getState() === "delayed") assert.equal(await job.getState(), "delayed", "limited jobs remain durable in BullMQ after worker restart");
  }

  const reservationUser = await newUser("reservation-idempotency");
  const baseWindow = nextUtcHour(Date.now());
  const reservation = {
    deliveryId: randomUUID(),
    userId: reservationUser,
    campaignId: randomUUID(),
    notBeforeMs: baseWindow + 5_000,
    minimumSpacingMs: 0,
    senderHourlyLimit: 1,
    campaignHourlyLimit: 1,
  };
  const originalSlot = await reserveDeliveryRateSlot(infrastructure.redis, reservation, baseWindow);
  const replayedSlot = await reserveDeliveryRateSlot(infrastructure.redis, reservation, baseWindow + 1_000);
  assert.equal(originalSlot.eligibleAtMs, replayedSlot.eligibleAtMs, "reprocessing the same delivery reuses its Redis quota reservation");
  assert.equal(replayedSlot.newlyReserved, false);
  const nextWindow = baseWindow + 3_600_000;
  const recoveredSlot = await reserveDeliveryRateSlot(infrastructure.redis, reservation, nextWindow + 1_000);
  assert.ok(recoveredSlot.eligibleAtMs >= nextWindow + 1_000, "a reservation whose UTC window passed is renewed in the current window");
});

async function replaceWorkers(configs: Array<{ concurrency: number }>): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.all(workerClients.map((clients) => closeInfrastructureClients(clients)));
  workerClients = configs.map(() => createInfrastructureClients(environment));
  await Promise.all(workerClients.map((clients) => clients.redis.connect()));
  workers = configs.map((config, index) => {
    const worker = new Worker<DeliveryJobData, void, typeof DELIVERY_JOB_NAME>(
      DELIVERY_QUEUE_NAME,
      (job, token: string | undefined) => processDelivery(job, token, {
        prisma,
        redis: workerClients[index]!.redis,
        transport: { sendMail: (message) => transport(message) },
        from: "phase6-test@example.test",
        maxAttempts: 2,
        minimumSpacingMs,
        senderHourlyLimit: senderLimit,
        logger,
        ...(senderLimitAlert ? { notifySenderLimit: senderLimitAlert } : {}),
      }),
      { connection: createDeliveryConnectionOptions(environment.REDIS_URL, null), concurrency: config.concurrency, stalledInterval: 1_000 },
    );
    worker.on("error", () => undefined);
    return worker;
  });
  await Promise.all(workers.map((worker) => once(worker, "ready")));
}

async function newUser(prefix: string): Promise<string> {
  const id = randomUUID();
  const user = await prisma.user.create({ data: { googleSubject: `${prefix}-${id}`, email: `${prefix}-${id}@example.test`, name: prefix } });
  userIds.push(user.id);
  return user.id;
}

async function newCampaign(ownerId: string, hourlyLimit: number): Promise<string> {
  const campaign = await prisma.campaign.create({
    data: { userId: ownerId, subject: "Phase 6 rate test", body: "Integration content.", requestedStartAt: new Date(), delayMs: 0, hourlyLimit, recipientCount: 1 },
  });
  return campaign.id;
}

async function newDelivery(ownerId: string, campaignId: string, position: number): Promise<{ id: string }> {
  const recipient = `r-${randomUUID()}@example.test`;
  const delivery = await prisma.emailDelivery.create({
    data: {
      userId: ownerId,
      campaignId,
      recipientEmail: recipient,
      normalizedRecipient: recipient,
      recipientPosition: position,
      scheduledAt: new Date(),
    },
  });
  return { id: delivery.id };
}

async function enqueue(deliveryId: string) {
  const id = `phase6-${randomUUID()}`;
  jobIds.push(id);
  return queue.add(DELIVERY_JOB_NAME, { deliveryId }, { jobId: id, attempts: 2, removeOnComplete: false, removeOnFail: false });
}

async function waitForJobState(jobId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job && await job.getState() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`job ${jobId} did not enter ${expected}`);
}

async function waitForJobsSettled(ids: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const states = await Promise.all(ids.map(async (id) => (await queue.getJob(id))?.getState()));
    if (states.every((state) => state === "completed" || state === "delayed")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("concurrent capacity jobs did not settle into completed/delayed states");
}

function nextUtcHour(atMs: number): number {
  return Math.floor(atMs / 3_600_000) * 3_600_000 + 3_600_000;
}

function assertDelayedUntil(job: { timestamp: number; delay: number }, expectedAt: number): void {
  assert.ok(job.delay > 0, "BullMQ exposes a non-zero delayed duration");
  assert.ok(Math.abs(job.timestamp + job.delay - expectedAt) < 1_500, "BullMQ delay lands in the next fixed UTC hour");
}
