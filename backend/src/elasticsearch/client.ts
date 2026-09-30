import { Client } from "@elastic/elasticsearch";

export const EMAIL_DELIVERY_INDEX = "mailflow-email-deliveries-v1";

export function createElasticsearchClient(url: string, apiKey?: string): Client {
  return new Client({ node: url, ...(apiKey ? { auth: { apiKey } } : {}) });
}

export async function ensureEmailDeliveryIndex(client: Client): Promise<void> {
  const exists = await client.indices.exists({ index: EMAIL_DELIVERY_INDEX });
  if (exists) return;
  try {
    await client.indices.create({
    index: EMAIL_DELIVERY_INDEX,
    mappings: {
      properties: {
        deliveryId: { type: "keyword" },
        userId: { type: "keyword" },
        campaignId: { type: "keyword" },
        recipientEmail: { type: "keyword", fields: { text: { type: "text" } } },
        normalizedRecipient: { type: "wildcard" },
        subject: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 998 } } },
        status: { type: "keyword" },
        scheduledAt: { type: "date" },
        sentAt: { type: "date" },
        createdAt: { type: "date" },
        updatedAt: { type: "date" },
      },
    },
    });
  } catch (error) {
    // API and worker can start together; a concurrent create is already success.
    if ((error as { statusCode?: number }).statusCode !== 400) throw error;
    if (!await client.indices.exists({ index: EMAIL_DELIVERY_INDEX })) throw error;
  }
}
