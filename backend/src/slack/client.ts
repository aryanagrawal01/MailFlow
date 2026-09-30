export type SlackChannel = { id: string; name: string; isPrivate: boolean; isMember: boolean };
export type SlackInstall = { accessToken: string; teamId: string; teamName: string; authedUserId: string | null };

export interface SlackOAuthProvider {
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<SlackInstall>;
}

export interface SlackApi {
  listChannels(botToken: string): Promise<SlackChannel[]>;
  postMessage(botToken: string, channelId: string, text: string): Promise<string | null>;
}

const BOT_SCOPES = ["chat:write", "chat:write.public", "channels:read", "groups:read"];

export function createSlackOAuthProvider(options: { clientId: string; clientSecret: string; redirectUri: string }): SlackOAuthProvider {
  return {
    authorizationUrl(state) {
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("scope", BOT_SCOPES.join(","));
      url.searchParams.set("redirect_uri", options.redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },
    async exchangeCode(code) {
      const body = new URLSearchParams({
        code,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: options.redirectUri,
      });
      const response = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json() as SlackOAuthResponse;
      if (!response.ok || !result.ok || !result.access_token || !result.team?.id) throw new SlackApiError(result.error ?? "oauth_exchange_failed");
      return {
        accessToken: result.access_token,
        teamId: result.team.id,
        teamName: result.team.name ?? result.team.id,
        authedUserId: result.authed_user?.id ?? null,
      };
    },
  };
}

export const slackApi: SlackApi = {
  async listChannels(botToken) {
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;
    do {
      const url = new URL("https://slack.com/api/conversations.list");
      url.searchParams.set("types", "public_channel,private_channel");
      url.searchParams.set("exclude_archived", "true");
      url.searchParams.set("limit", "200");
      if (cursor) url.searchParams.set("cursor", cursor);
      const result = await slackGet<SlackChannelsResponse>(url, botToken);
      channels.push(...(result.channels ?? []).filter((channel) => channel.id && channel.name).map((channel) => ({
        id: channel.id!, name: channel.name!, isPrivate: channel.is_private === true, isMember: channel.is_member === true,
      })));
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return channels;
  },
  async postMessage(botToken, channelId, text) {
    const result = await slackRequest<SlackPostResponse>("https://slack.com/api/chat.postMessage", botToken, { channel: channelId, text });
    return result.ts ?? null;
  },
};

export class SlackApiError extends Error {
  constructor(readonly slackCode: string) {
    super("Slack API request failed");
    this.name = "SlackApiError";
  }
}

async function slackGet<T extends SlackResponse>(url: URL, token: string): Promise<T> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) });
  const body = await response.json() as T;
  if (!response.ok || !body.ok) throw new SlackApiError(body.error ?? `http_${response.status}`);
  return body;
}

async function slackRequest<T extends SlackResponse>(url: string, token: string, payload: object): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json() as T;
  if (!response.ok || !body.ok) throw new SlackApiError(body.error ?? `http_${response.status}`);
  return body;
}

type SlackResponse = { ok: boolean; error?: string };
type SlackOAuthResponse = SlackResponse & {
  access_token?: string;
  team?: { id: string; name?: string };
  authed_user?: { id?: string };
};
type SlackChannelsResponse = SlackResponse & {
  channels?: Array<{ id?: string; name?: string; is_private?: boolean; is_member?: boolean }>;
  response_metadata?: { next_cursor?: string };
};
type SlackPostResponse = SlackResponse & { ts?: string };
