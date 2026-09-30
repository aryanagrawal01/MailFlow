import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { Queue, Worker } from "bullmq";
import { createDeliveryConnectionOptions, loadServerEnvironment } from "@mailflow/shared";

const execFileAsync = promisify(execFile);
const environment = loadServerEnvironment(process.env);
const suffix = randomUUID();
const queueName = `mailflow-ops-restart-${suffix}`;
const delayedJobId = `restart-delayed-${suffix}`;
const activeJobId = `restart-active-${suffix}`;
const workerRestartJobId = `worker-restart-${suffix}`;
const repoRoot = resolve(process.cwd(), "..");
const queue = new Queue(queueName, {
  connection: createDeliveryConnectionOptions(environment.REDIS_URL, 1),
  defaultJobOptions: { removeOnComplete: { age: 60, count: 20 }, removeOnFail: { age: 60, count: 20 } },
});
// Redis restart intentionally produces a short connection error while ioredis
// reconnects. The test asserts recovery below; handle the expected event so it
// is not printed as an unhandled EventEmitter error.
queue.on("error", () => undefined);
const cleanup: Array<() => Promise<unknown>> = [() => queue.close()];

after(async () => { await Promise.allSettled(cleanup.map((close) => close())); });

test("a delayed job survives Redis restart and a BullMQ worker reconnects", async () => {
  let worker: Worker | undefined;
  try {
    await queue.waitUntilReady();
    await queue.add("restart-probe", { probe: "delayed" }, { jobId: delayedJobId, delay: 60_000 });
    const before = await queue.getJob(delayedJobId);
    assert.ok(before);
    assert.equal(await before.getState(), "delayed");

    worker = new Worker(queueName, async (job) => ({ received: job.id }), {
      connection: createDeliveryConnectionOptions(environment.REDIS_URL, null),
      concurrency: 1,
      maxStalledCount: 2,
      stalledInterval: 30_000,
    });
    cleanup.unshift(() => worker?.close() ?? Promise.resolve());
    await worker.waitUntilReady();

    worker.on("error", () => undefined);
    await execFileAsync("docker", ["compose", "-f", "docker-compose.yml", "restart", "redis"], { cwd: repoRoot, timeout: 60_000 });

    const deadline = Date.now() + 30_000;
    let afterRestart = undefined;
    while (!afterRestart && Date.now() < deadline) {
      try { afterRestart = await queue.getJob(delayedJobId); } catch { /* Redis is still reconnecting */ }
      if (!afterRestart) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    assert.ok(afterRestart, "Redis persistence must retain the delayed job");
    assert.equal(await afterRestart.getState(), "delayed");

    const completed = once(worker, "completed");
    let enqueued = false;
    while (!enqueued && Date.now() < deadline) {
      try { await queue.add("restart-probe", { probe: "immediate" }, { jobId: activeJobId }); enqueued = true; }
      catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 250)); }
    }
    assert.ok(enqueued, "queue client should reconnect and accept work");
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const completionTimeout = new Promise<never>((_resolve, reject) => { timeoutHandle = setTimeout(() => reject(new Error("Worker did not resume consuming jobs within 30 seconds")), 30_000); });
    let completionEvent: unknown[];
    try { completionEvent = await Promise.race([completed, completionTimeout]); }
    finally { if (timeoutHandle) clearTimeout(timeoutHandle); }
    const [job] = completionEvent as [{ id?: string }];
    assert.equal(job?.id, activeJobId, "reconnected worker should resume consuming jobs");
  } finally {
    await worker?.close().catch(() => undefined);
    for (const jobId of [delayedJobId, activeJobId]) {
      const job = await queue.getJob(jobId).catch(() => undefined);
      await job?.remove().catch(() => undefined);
    }
  }
});

test("a replacement worker consumes durable waiting work after a worker restart", async () => {
  const saved = await queue.add("restart-probe", { probe: "worker-restart" }, { jobId: workerRestartJobId });
  assert.equal(await saved.getState(), "waiting");
  const replacement = new Worker(queueName, async (job) => ({ received: job.id }), {
    connection: createDeliveryConnectionOptions(environment.REDIS_URL, null),
    concurrency: 1,
    maxStalledCount: 2,
    stalledInterval: 30_000,
  });
  replacement.on("error", () => undefined);
  try {
    const [job] = await once(replacement, "completed") as [{ id?: string }];
    assert.equal(job?.id, workerRestartJobId);
  } finally {
    await replacement.close();
    const job = await queue.getJob(workerRestartJobId);
    await job?.remove();
  }
});
