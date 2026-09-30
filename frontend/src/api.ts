import { frontendEnvironment } from "./env";

const API = `${frontendEnvironment.VITE_API_BASE_URL.replace(/\/$/, "")}/api`;
export type User = { id: string; email: string; name: string; avatarUrl: string | null };
export type Delivery = { id?: string; deliveryId?: string; recipientEmail: string; subject?: string; status: "scheduled" | "processing" | "sent" | "failed" | "delivery_unknown"; scheduledAt: string; sentAt: string | null; createdAt: string; campaign?: { subject: string } };
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };
export type SlackConnection = { connected: boolean; team: { id: string; name: string } | null; channel: { id: string; name: string } | null; connectedAt: string | null };
export type SlackChannel = { id: string; name: string; isPrivate: boolean; isMember: boolean };

export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`${API}${path}`, { ...init, credentials: "include", headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } }); }
  catch { throw new ApiError("MailFlow could not connect to the server. Check that the API is running.", 0); }
  if (response.status === 401) { window.dispatchEvent(new Event("mailflow:unauthorized")); throw new ApiError("Your session has expired. Please sign in again.", 401); }
  if (!response.ok) {
    let message = "That request could not be completed. Please try again.";
    try { const body = await response.json() as { error?: unknown }; if (typeof body.error === "string") message = body.error; } catch { /* use safe generic message */ }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const api = {
  me: () => request<{ user: User }>("/auth/me"),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  schedule: (input: { subject: string; body: string; recipients: string[]; startAt: string; delayMs: number; hourlyLimit: number }) => request<{ campaign: { id: string }; deliveries: Delivery[] }>("/campaigns", { method: "POST", body: JSON.stringify(input) }),
  deliveries: (status: string, page: number, pageSize: number) => request<Page<Delivery>>(`/deliveries?status=${encodeURIComponent(status)}&page=${page}&pageSize=${pageSize}`),
  search: (params: URLSearchParams) => request<Page<Delivery & { recipientEmail: string }>>(`/deliveries/search?${params}`),
  slack: () => request<SlackConnection>("/slack/connection"),
  channels: () => request<{ channels: SlackChannel[] }>("/slack/channels"),
  selectChannel: (channelId: string) => request<{ channel: { id: string; name: string } }>("/slack/channel", { method: "PUT", body: JSON.stringify({ channelId }) }),
  disconnectSlack: () => request<void>("/slack/connection", { method: "DELETE" }),
  slackStartUrl: () => `${API}/slack/oauth/start`,
  googleStartUrl: () => `${API}/auth/google/start`,
};
