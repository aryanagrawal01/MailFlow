import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import type { Queue } from "bullmq";
import type { DeliveryJobData } from "@mailflow/shared";
import { DELIVERY_QUEUE_NAME } from "@mailflow/shared";

export const QUEUE_DASHBOARD_PATH = "/admin/queues";

/** Read-only Bull Board. Jobs contain only delivery IDs; delivery details remain owner-scoped in the API. */
export function createQueueDashboard(queue: Queue<DeliveryJobData>) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(QUEUE_DASHBOARD_PATH);
  createBullBoard({
    queues: [new BullMQAdapter(queue, {
      readOnlyMode: true,
      allowRetries: false,
      displayName: DELIVERY_QUEUE_NAME,
      description: "Scheduled email delivery jobs",
    })],
    serverAdapter,
    options: { uiConfig: { boardTitle: "MailFlow Queues", hideRedisDetails: true, showWorkers: true } },
  });
  return serverAdapter.getRouter();
}
