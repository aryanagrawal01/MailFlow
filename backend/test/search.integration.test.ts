import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { checkReadiness, closeInfrastructureClients, createInfrastructureClients, loadServerEnvironment } from "@mailflow/shared";
import { createApplicationSession } from "../src/auth/session.js";
import { createApp } from "../src/app.js";
import { createPrismaClient } from "../src/db/client.js";
import { createElasticsearchClient, EMAIL_DELIVERY_INDEX } from "../src/elasticsearch/client.js";
import { DeliverySearchIndexer } from "../src/elasticsearch/indexer.js";

const suffix = randomUUID();
const environment = loadServerEnvironment(process.env);
const prisma = createPrismaClient(environment.DATABASE_URL);
const infrastructure = createInfrastructureClients(environment);
const es = createElasticsearchClient(environment.ELASTICSEARCH_URL, environment.ELASTICSEARCH_API_KEY);
const logger = pino({ enabled: false });
const indexer = new DeliverySearchIndexer(prisma, es, logger);
let ownerId = "";
let otherId = "";
let token = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let baseUrl = "";
const deliveryIds: string[] = [];

before(async () => {
  const owner = await prisma.user.create({ data: { googleSubject: `search-owner-${suffix}`, email: `search-owner-${suffix}@example.test`, name: "Search owner" } });
  const other = await prisma.user.create({ data: { googleSubject: `search-other-${suffix}`, email: `search-other-${suffix}@example.test`, name: "Other owner" } });
  ownerId = owner.id; otherId = other.id;
  token = (await createApplicationSession(prisma, ownerId, 1)).token;
  await indexer.reconcilePending();
  const app = createApp(logger, environment, infrastructure, {
    prisma,
    handoff: { reconcile: async () => ({ examined: 0, enqueued: 0, failed: 0 }) },
    searchClient: es,
    searchIndexer: indexer,
  });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) { server.close(); await once(server, "close"); }
  for (const id of deliveryIds) await es.delete({ index: EMAIL_DELIVERY_INDEX, id }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId].filter(Boolean) } } });
  await Promise.allSettled([prisma.$disconnect(), es.close(), closeInfrastructureClients(infrastructure)]);
});

test("delivery indexing, status updates, search filters, pagination, ownership, outage recovery, and deterministic IDs", async () => {
  const startAt = new Date(Date.now() + 30 * 60_000);
  const campaign = await prisma.campaign.create({ data: {
    userId: ownerId, subject: `Quarterly Launch ${suffix}`, body: "Index test", requestedStartAt: startAt,
    delayMs: 2_000, hourlyLimit: 20, recipientCount: 3,
  } });
  const recipients = [`alpha-${suffix}@example.test`, `beta-${suffix}@example.test`, `gamma-${suffix}@example.test`];
  const rows = await prisma.emailDelivery.createManyAndReturn({ data: recipients.map((recipientEmail, recipientPosition) => ({
    userId: ownerId, campaignId: campaign.id, recipientEmail, normalizedRecipient: recipientEmail.toLowerCase(),
    recipientPosition, scheduledAt: new Date(startAt.getTime() + recipientPosition * 2_000),
  })) });
  deliveryIds.push(...rows.map((row) => row.id));
  const otherCampaign = await prisma.campaign.create({ data: {
    userId: otherId, subject: `Private marker ${suffix}`, body: "Other tenant", requestedStartAt: startAt,
    delayMs: 2_000, hourlyLimit: 20, recipientCount: 1,
  } });
  const otherDelivery = await prisma.emailDelivery.create({ data: {
    userId: otherId, campaignId: otherCampaign.id, recipientEmail: `secret-${suffix}@example.test`, normalizedRecipient: `secret-${suffix}@example.test`,
    recipientPosition: 0, scheduledAt: startAt,
  } });
  deliveryIds.push(otherDelivery.id);
  assert.equal((await indexer.reconcilePending()).failed, 0);
  assert.equal((await es.get({ index: EMAIL_DELIVERY_INDEX, id: rows[0]!.id }))._id, rows[0]!.id);

  const sentAt = new Date();
  await prisma.emailDelivery.update({ where: { id: rows[0]!.id }, data: { status: "sent", sentAt } });
  await prisma.emailDelivery.update({ where: { id: rows[1]!.id }, data: { status: "failed", failureCode: "TEST_FAILURE" } });
  await indexer.reconcilePending();
  assert.equal((await es.get<{ status: string }>({ index: EMAIL_DELIVERY_INDEX, id: rows[0]!.id }))._source?.status, "sent");
  assert.equal((await es.get<{ status: string }>({ index: EMAIL_DELIVERY_INDEX, id: rows[1]!.id }))._source?.status, "failed");

  const search = async (query = "") => fetch(`${baseUrl}/api/deliveries/search${query}`, { headers: { cookie: `${environment.SESSION_COOKIE_NAME}=${token}` } });
  const scheduledResponse = await search(`?recipient=${encodeURIComponent(recipients[2]!)}`);
  const scheduled = await scheduledResponse.json() as { items: Array<{ status: string; recipientEmail: string }>; total: number };
  assert.equal(scheduled.total, 1); assert.equal(scheduled.items[0]?.status, "scheduled");
  const bySubject = await (await search(`?subject=${encodeURIComponent("Quarterly Launch")}`)).json() as { total: number };
  assert.equal(bySubject.total, 3);
  const sent = await (await search("?status=sent")).json() as { total: number };
  assert.equal(sent.total, 1);
  const failed = await (await search("?status=failed")).json() as { total: number };
  assert.equal(failed.total, 1);
  const page = await (await search("?page=1&pageSize=2")).json() as { items: unknown[]; total: number; page: number };
  assert.equal(page.total, 3); assert.equal(page.items.length, 2); assert.equal(page.page, 1);
  const privateSearch = await (await search(`?recipient=${encodeURIComponent(`secret-${suffix}`)}`)).json() as { total: number };
  assert.equal(privateSearch.total, 0);
  const sentTimeFilter = await (await search(`?sentFrom=${encodeURIComponent(new Date(sentAt.getTime() - 60_000).toISOString())}&sentTo=${encodeURIComponent(new Date(sentAt.getTime() + 60_000).toISOString())}`)).json() as { total: number };
  assert.equal(sentTimeFilter.total, 1);
  const unauthorized = await fetch(`${baseUrl}/api/deliveries/search?status=sent`);
  assert.equal(unauthorized.status, 401);
  const readinessDuringSearchOutage = await checkReadiness({ ...environment, ELASTICSEARCH_URL: "http://127.0.0.1:1" }, infrastructure, logger);
  assert.equal(readinessDuringSearchOutage.status, "ready");
  assert.equal(readinessDuringSearchOutage.dependencies.elasticsearch, "error");

  // Unavailable ES leaves transactional outbox work pending. Reconciliation repairs it.
  const broken = createElasticsearchClient("http://127.0.0.1:1");
  const outageIndexer = new DeliverySearchIndexer(prisma, broken, logger);
  const outageApp = createApp(logger, environment, infrastructure, {
    prisma, handoff: { reconcile: async () => ({ examined: 0, enqueued: 0, failed: 0 }) },
    searchClient: broken, searchIndexer: outageIndexer,
  });
  const outageServer = outageApp.listen(0, "127.0.0.1");
  await once(outageServer, "listening");
  const outageUrl = `http://127.0.0.1:${(outageServer.address() as AddressInfo).port}`;
  const acceptedDuringOutage = await fetch(`${outageUrl}/api/campaigns`, {
    method: "POST", headers: { cookie: `${environment.SESSION_COOKIE_NAME}=${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      subject: `Outage durable ${suffix}`, body: "Must not block schedule", recipients: [`outage-${suffix}@example.test`],
      startAt: startAt.toISOString(), delayMs: environment.MIN_DELAY_MS, hourlyLimit: 20,
    }),
  });
  assert.equal(acceptedDuringOutage.status, 201);
  const acceptedBody = await acceptedDuringOutage.json() as { deliveries: Array<{ id: string }> };
  const outageDeliveryId = acceptedBody.deliveries[0]!.id;
  deliveryIds.push(outageDeliveryId);
  outageServer.close(); await once(outageServer, "close");
  await assert.rejects(outageIndexer.reconcilePending());
  assert.equal(await prisma.searchIndexOutbox.count({ where: { deliveryId: outageDeliveryId, state: "pending" } }), 1);
  await broken.close();
  const repaired = await indexer.reconcilePending();
  assert.equal(repaired.failed, 0);
  const repairedOutbox = await prisma.searchIndexOutbox.findUniqueOrThrow({ where: { deliveryId: outageDeliveryId } });
  assert.equal(repairedOutbox.state, "indexed");
  await indexer.reconcilePending();
  const deterministic = await es.count({ index: EMAIL_DELIVERY_INDEX, query: { term: { deliveryId: outageDeliveryId } } });
  assert.equal(deterministic.count, 1);
});
