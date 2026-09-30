import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { test } from "node:test";
import { createPrismaClient } from "../src/db/client.js";
import { loadServerEnvironment } from "@mailflow/shared";

const execFileAsync = promisify(execFile);
const environment = loadServerEnvironment(process.env);
const prisma = createPrismaClient(environment.DATABASE_URL);
const repoRoot = resolve(process.cwd(), "..");

test("PostgreSQL restart preserves committed state and the live Prisma client recovers", async () => {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: {
    googleSubject: `postgres-restart-${suffix}`,
    email: `postgres-restart-${suffix}@example.test`,
    name: "PostgreSQL restart probe",
  } });
  try {
    await execFileAsync("docker", ["compose", "-f", "docker-compose.yml", "restart", "postgres"], {
      cwd: repoRoot,
      timeout: 60_000,
    });

    const deadline = Date.now() + 45_000;
    let recovered: typeof user | null = null;
    let lastError: unknown;
    while (!recovered && Date.now() < deadline) {
      try {
        recovered = await prisma.user.findUnique({ where: { id: user.id } });
      } catch (error) {
        lastError = error;
      }
      if (!recovered) await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    const lastErrorName = lastError instanceof Error ? lastError.name : "unknown error";
    assert.ok(recovered, `database did not recover before timeout (last error: ${lastErrorName})`);
    assert.equal(recovered.id, user.id);
    assert.equal(recovered.googleSubject, user.googleSubject, "committed PostgreSQL state survives container restart");
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
