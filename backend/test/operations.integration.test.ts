import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import type { AddressInfo } from "node:net";
import pino from "pino";
import {
  closeInfrastructureClients,
  createDeliveryQueue,
  createInfrastructureClients,
  DELIVERY_JOB_NAME,
  DELIVERY_JOB_RETENTION,
  DELIVERY_QUEUE_NAME,
  loadServerEnvironment,
} from "@mailflow/shared";
import { createApplicationSession } from "../src/auth/session.js";
import { createApp } from "../src/app.js";
import { createPrismaClient } from "../src/db/client.js";

const suffix = randomUUID();
const environment = loadServerEnvironment(process.env);
const prisma = createPrismaClient(environment.DATABASE_URL);
const infrastructure = createInfrastructureClients(environment);
const queue = createDeliveryQueue(environment.REDIS_URL, { attempts: environment.DELIVERY_MAX_ATTEMPTS });
const scheduledJobIds = [`ops-waiting-${suffix}`, `ops-delayed-${suffix}`];
let ownerId = "";
let sessionCookie = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let outageServer: ReturnType<ReturnType<typeof createApp>["listen"]>;
let baseUrl = "";

before(async () => {
  const user = await prisma.user.create({
    data: { googleSubject: `ops-user-${suffix}`, email: `ops-user-${suffix}@example.test`, name: "Operations Test" },
  });
  ownerId = user.id;
  const session = await createApplicationSession(prisma, ownerId, 1);
  sessionCookie = `${environment.SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}`;

  await queue.add(DELIVERY_JOB_NAME, { deliveryId: randomUUID() }, { jobId: scheduledJobIds[0] });
  await queue.add(DELIVERY_JOB_NAME, { deliveryId: randomUUID() }, { jobId: scheduledJobIds[1], delay: 60_000 });

  const app = createApp(pino({ enabled: false }), environment, infrastructure, { prisma, deliveryQueue: queue });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const searchOutageEnvironment = loadServerEnvironment({ ...process.env, ELASTICSEARCH_URL: "http://127.0.0.1:1" });
  const outageApp = createApp(pino({ enabled: false }), searchOutageEnvironment, infrastructure, { prisma });
  outageServer = outageApp.listen(0, "127.0.0.1");
  await once(outageServer, "listening");
});

after(async () => {
  for (const target of [server, outageServer]) {
    if (target?.listening) {
      target.close();
      await once(target, "close");
    }
  }
  for (const jobId of scheduledJobIds) {
    const job = await queue.getJob(jobId);
    if (job) await job.remove();
  }
  await queue.close();
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
  await closeInfrastructureClients(infrastructure);
});

test("health is lightweight and readiness reports each dependency without requiring Elasticsearch", async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "mailflow-api" });

  const ready = await fetch(`${baseUrl}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    status: "ready",
    dependencies: { postgres: "ok", redis: "ok", elasticsearch: "ok" },
  });

  const outageAddress = outageServer.address() as AddressInfo;
  const searchOutage = await fetch(`http://127.0.0.1:${outageAddress.port}/ready`);
  assert.equal(searchOutage.status, 200);
  assert.deepEqual(await searchOutage.json(), {
    status: "ready",
    dependencies: { postgres: "ok", redis: "ok", elasticsearch: "error" },
  });
});

test("BullMQ Board requires a session, is read-only, and shows queue states", async () => {
  const anonymous = await fetch(`${baseUrl}/admin/queues`);
  assert.equal(anonymous.status, 401);

  const headers = { cookie: sessionCookie };
  const page = await fetch(`${baseUrl}/admin/queues`, { headers });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Bull Board|BullMQ|queues/i);

  const queues = await fetch(`${baseUrl}/admin/queues/api/queues?activeQueue=${encodeURIComponent(DELIVERY_QUEUE_NAME)}&status=waiting&jobsPerPage=10`, { headers });
  assert.equal(queues.status, 200);
  const payload = await queues.json() as { queues: Array<{ name: string; counts: Record<string, number>; readOnlyMode: boolean; jobs: Array<{ data: Record<string, unknown> }> }> };
  const deliveryQueue = payload.queues.find((item) => item.name === DELIVERY_QUEUE_NAME);
  assert.ok(deliveryQueue, "delivery queue is visible in Bull Board");
  assert.ok("waiting" in deliveryQueue.counts && "delayed" in deliveryQueue.counts && "active" in deliveryQueue.counts && "completed" in deliveryQueue.counts && "failed" in deliveryQueue.counts);
  assert.ok(deliveryQueue.counts.waiting >= 1);
  assert.ok(deliveryQueue.counts.delayed >= 1);
  assert.equal(deliveryQueue.readOnlyMode, true);
  assert.ok(deliveryQueue.jobs.some((job) => Object.keys(job.data).length === 1 && typeof job.data.deliveryId === "string"));
  assert.doesNotMatch(JSON.stringify(payload), /redis:\/\/[^\s"']+|password/i);

  const mutation = await fetch(`${baseUrl}/admin/queues/api/queues/${DELIVERY_QUEUE_NAME}/pause`, { method: "PUT", headers });
  assert.equal(mutation.status, 405, "read-only dashboard rejects queue mutations");
  assert.equal(await queue.isPaused(), false);
});

test("job retry count and completed/failed retention are bounded and explicit", async () => {
  assert.equal(queue.opts.defaultJobOptions?.attempts, environment.DELIVERY_MAX_ATTEMPTS);
  assert.ok(Number.isInteger(queue.opts.defaultJobOptions?.attempts) && (queue.opts.defaultJobOptions?.attempts ?? 0) <= 10);
  assert.deepEqual(queue.opts.defaultJobOptions?.removeOnComplete, DELIVERY_JOB_RETENTION.completed);
  assert.deepEqual(queue.opts.defaultJobOptions?.removeOnFail, DELIVERY_JOB_RETENTION.failed);
  assert.deepEqual(DELIVERY_JOB_RETENTION, {
    completed: { age: 7 * 24 * 60 * 60, count: 10_000 },
    failed: { age: 30 * 24 * 60 * 60, count: 20_000 },
  });
});
