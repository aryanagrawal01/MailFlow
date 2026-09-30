import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createServer } from "node:http";
import express from "express";
import pino from "pino";
import { loadServerEnvironment } from "@mailflow/shared";
import { createAuthRouter } from "../src/auth/router.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";

test("MailFlow registration and username/password sign-in issue application sessions", async (t) => {
  const environment = loadServerEnvironment({
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    ELASTICSEARCH_URL: "http://localhost:9200",
    FRONTEND_ORIGIN: "http://localhost:5173",
  });
  const users: Array<Record<string, unknown>> = [];
  const sessions: Array<Record<string, unknown>> = [];
  const prisma = {
    user: {
      async findFirst({ where }: { where: { OR: Array<Record<string, unknown>> } }) {
        return users.find((user) => where.OR.some((condition) => {
          if (typeof condition.username === "string") return user.username === condition.username;
          const email = condition.email as { equals: string } | undefined;
          return email ? user.email === email.equals : false;
        })) ?? null;
      },
      async create({ data }: { data: Record<string, unknown> }) {
        const user = { id: randomUUID(), googleSubject: null, ...data };
        users.push(user);
        return user;
      },
    },
    session: {
      async create({ data }: { data: Record<string, unknown> }) {
        const session = { id: randomUUID(), ...data };
        sessions.push(session);
        return session;
      },
    },
  } as unknown as PrismaClient;
  const app = express();
  app.use(express.json());
  app.use("/api/auth", createAuthRouter({ environment, prisma, logger: pino({ enabled: false }) }));
  const server = createServer(app).listen(0, "127.0.0.1");
  t.after(async () => { server.close(); await once(server, "close"); });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/api/auth`;
  const account = { name: "Unit Test User", username: "unit.test-user", email: "unit@example.test", contactNumber: "+1 555 123 4567", password: "unit-test-password-123" };
  const register = await fetch(`${baseUrl}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(account) });
  assert.equal(register.status, 201, await register.clone().text());
  assert.match(register.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.equal(sessions.length, 1);
  assert.equal(users.length, 1);
  assert.equal(users[0]?.googleSubject, null);
  assert.equal(users[0]?.passwordHash === account.password, false);
  assert.match(String(users[0]?.passwordHash), /^scrypt\$/);

  const wrong = await fetch(`${baseUrl}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: account.username, password: "wrong-password" }) });
  assert.equal(wrong.status, 401);
  const login = await fetch(`${baseUrl}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: account.email, password: account.password }) });
  assert.equal(login.status, 200, await login.clone().text());
  assert.match(login.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.equal(sessions.length, 2);

  const invalid = await fetch(`${baseUrl}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...account, username: "x" }) });
  assert.equal(invalid.status, 400);
});
