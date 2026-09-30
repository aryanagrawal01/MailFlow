import type { Redis } from "ioredis";

const HOUR_MS = 60 * 60 * 1_000;
// A shared Redis Cluster hash tag keeps the sender and campaign keys touched
// by each Lua transaction in one slot.
const RATE_HASH_TAG = "{mailflow-rate}";

const RESERVE_LUA = `
local existing = redis.call('HGET', KEYS[1], 'slotAt')
local existingHour = tonumber(redis.call('HGET', KEYS[1], 'hourStart') or '-1')
local now = tonumber(ARGV[1])
local currentHour = math.floor(now / 3600000) * 3600000
if existing and existingHour >= currentHour then
  return { tonumber(existing), 0, 0 }
end
if existing then
  -- The reserved window has passed without the job being sent. Re-reserve in
  -- the current window so a long worker/Redis outage cannot bypass this hour's cap.
  redis.call('DEL', KEYS[1])
end

local notBefore = tonumber(ARGV[2])
local spacingMs = tonumber(ARGV[3])
local senderLimit = tonumber(ARGV[4])
local campaignLimit = tonumber(ARGV[5])
local senderPrefix = ARGV[6]
local campaignPrefix = ARGV[7]
local spacingKey = KEYS[2]
local candidate = math.max(now, notBefore, tonumber(redis.call('GET', spacingKey) or '0'))
local senderLimitReachedHour = 0

for _ = 1, 10000 do
  local hourStart = math.floor(candidate / 3600000) * 3600000
  local senderKey = senderPrefix .. tostring(hourStart)
  local campaignKey = campaignPrefix .. tostring(hourStart)
  local senderCount = tonumber(redis.call('GET', senderKey) or '0')
  local campaignCount = tonumber(redis.call('GET', campaignKey) or '0')
  if senderCount < senderLimit and campaignCount < campaignLimit then
    redis.call('INCR', senderKey)
    redis.call('PEXPIREAT', senderKey, hourStart + 3600000 + 86400000)
    redis.call('INCR', campaignKey)
    redis.call('PEXPIREAT', campaignKey, hourStart + 3600000 + 86400000)
    local nextSenderAt = candidate + spacingMs
    redis.call('SET', spacingKey, nextSenderAt, 'PXAT', nextSenderAt + 86400000)
    redis.call('HSET', KEYS[1], 'slotAt', candidate, 'hourStart', hourStart)
    redis.call('PEXPIREAT', KEYS[1], candidate + 2592000000)
    return { candidate, 1, senderLimitReachedHour }
  end
  if senderCount >= senderLimit and senderLimitReachedHour == 0 then
    -- Alert for the UTC hour in which this worker observed exhaustion. A
    -- reservation may have scanned future windows while locating capacity.
    senderLimitReachedHour = currentHour
  end
  candidate = math.max(hourStart + 3600000, candidate + 1)
end

return redis.error_reply('Unable to reserve a delivery slot within the search horizon')
`;

const ACQUIRE_SPACING_LUA = `
local reservation = redis.call('GET', KEYS[1])
if reservation then
  return { tonumber(reservation), 0 }
end
local now = tonumber(ARGV[1])
local spacingMs = tonumber(ARGV[2])
local nextAllowed = tonumber(redis.call('GET', KEYS[2]) or '0')
if nextAllowed > now then
  return { nextAllowed, 0 }
end
local nextAt = now + spacingMs
redis.call('SET', KEYS[2], nextAt, 'PXAT', nextAt + 86400000)
redis.call('SET', KEYS[1], now, 'PXAT', now + 2592000000)
return { now, 1 }
`;

export interface DeliveryRateRequest {
  deliveryId: string;
  userId: string;
  campaignId: string;
  notBeforeMs: number;
  minimumSpacingMs: number;
  senderHourlyLimit: number;
  campaignHourlyLimit: number;
}

export interface DeliveryRateReservation {
  eligibleAtMs: number;
  newlyReserved: boolean;
  senderLimitReachedHourStartMs: number | null;
}

/** Atomically reserves one durable delivery slot across sender and campaign windows. */
export async function reserveDeliveryRateSlot(
  redis: Redis,
  request: DeliveryRateRequest,
  nowMs = Date.now(),
): Promise<DeliveryRateReservation> {
  const reservationKey = `mailflow:${RATE_HASH_TAG}:reservation:${request.deliveryId}`;
  const spacingKey = `mailflow:${RATE_HASH_TAG}:spacing-plan:${request.userId}`;
  const senderPrefix = `mailflow:${RATE_HASH_TAG}:sender:${request.userId}:`;
  const campaignPrefix = `mailflow:${RATE_HASH_TAG}:campaign:${request.campaignId}:`;
  const result = await redis.eval(
    RESERVE_LUA,
    2,
    reservationKey,
    spacingKey,
    String(nowMs),
    String(request.notBeforeMs),
    String(request.minimumSpacingMs),
    String(request.senderHourlyLimit),
    String(request.campaignHourlyLimit),
    senderPrefix,
    campaignPrefix,
  ) as [number | string, number | string, number | string];
  const senderLimitReachedHourStartMs = Number(result[2]);
  return {
    eligibleAtMs: Number(result[0]),
    newlyReserved: Number(result[1]) === 1,
    senderLimitReachedHourStartMs: senderLimitReachedHourStartMs > 0 ? senderLimitReachedHourStartMs : null,
  };
}

/** Applies a second atomic spacing gate at actual worker start time. */
export async function acquireSenderSpacing(
  redis: Redis,
  userId: string,
  attemptId: string,
  minimumSpacingMs: number,
  nowMs = Date.now(),
): Promise<{ eligibleAtMs: number; acquired: boolean }> {
  const result = await redis.eval(
    ACQUIRE_SPACING_LUA,
    2,
    `mailflow:${RATE_HASH_TAG}:spacing-attempt:${attemptId}`,
    `mailflow:${RATE_HASH_TAG}:spacing-send:${userId}`,
    String(nowMs),
    String(minimumSpacingMs),
  ) as [number | string, number | string];
  return { eligibleAtMs: Number(result[0]), acquired: Number(result[1]) === 1 };
}

export const utcHourMilliseconds = HOUR_MS;
