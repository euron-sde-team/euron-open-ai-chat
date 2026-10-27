/**
 * Daily allowances (ADR 0011): weighted tokens and generated images per UTC day, from the
 * user's quota tier (or the default tier) with an optional per-user override on top.
 * There is no billing: admins decide who gets how much.
 *
 * Counting
 *   Redis holds today's running totals (`quota:<user>:<day>:tokens|images`, kept 48h) so
 *   every API task and worker sees the same numbers. usage_daily in Postgres is the
 *   durable record; when a Redis counter is missing (a restart, an eviction) it is seeded
 *   from usage_daily before the first increment, with SET NX so two tasks cannot both seed.
 *
 *   Tokens are charged after a turn, when the provider reports them: a turn is allowed to
 *   start while the user is under the limit and may finish a little over it. Images are
 *   reserved before generation with an atomic check-and-increment (Lua), and released if
 *   generation fails, so a burst of parallel requests cannot draw past the limit.
 *
 *   A model's weight multiplies its tokens: a large model can count 4x, a small one 0.25x.
 */
import type { Usage } from "@open-chat/types";
import { sql } from "kysely";
import { tooMany } from "../core/errors";
import { db, type Executor } from "../db/kysely";
import { redis } from "../integrations/redis";

export interface Limits {
  /** Null means unlimited. */
  dailyTokens: number | null;
  dailyImages: number | null;
  maxFileMb: number;
}

const DAY_TTL_SECONDS = 48 * 3600;

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function nextUtcMidnight(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

const key = (userId: string, day: string, what: "tokens" | "images") => `quota:${userId}:${day}:${what}`;

/** The tier (or the default tier) with the user's override applied. */
export async function limitsFor(userId: string, exec: Executor = db): Promise<Limits> {
  const row = await exec
    .selectFrom("users as u")
    .leftJoin("quota_tiers as t", "t.id", "u.quota_tier_id")
    .leftJoin("quota_tiers as d", (j) => j.on("d.is_default", "=", true))
    .leftJoin("user_quota_overrides as o", "o.user_id", "u.id")
    .select([
      "t.id as tier_id",
      "t.daily_tokens as t_tokens",
      "t.daily_images as t_images",
      "t.max_file_mb as t_mb",
      "d.daily_tokens as d_tokens",
      "d.daily_images as d_images",
      "d.max_file_mb as d_mb",
      "o.user_id as o_user",
      "o.daily_tokens as o_tokens",
      "o.daily_images as o_images",
    ])
    .where("u.id", "=", userId)
    .executeTakeFirst();
  if (!row) return { dailyTokens: 0, dailyImages: 0, maxFileMb: 1 };
  const onTier = row.tier_id !== null;
  const tierTokens = onTier ? row.t_tokens : row.d_tokens;
  const tierImages = onTier ? row.t_images : row.d_images;
  const maxFileMb = (onTier ? row.t_mb : row.d_mb) ?? 25;
  const n = (v: number | string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  return {
    dailyTokens: row.o_user && row.o_tokens !== null ? n(row.o_tokens) : n(tierTokens),
    dailyImages: row.o_user && row.o_images !== null ? n(row.o_images) : n(tierImages),
    maxFileMb,
  };
}

/** Make sure today's Redis counter exists, seeding it from usage_daily if it does not. */
async function seeded(userId: string, day: string, what: "tokens" | "images"): Promise<string> {
  const k = key(userId, day, what);
  if (await redis().exists(k)) return k;
  const column = what === "tokens" ? "weighted_tokens" : "images";
  const row = await db
    .selectFrom("usage_daily")
    .select(sql<string>`coalesce(sum(${sql.ref(column)}), 0)`.as("n"))
    .where("user_id", "=", userId)
    .where("day", "=", sql<Date>`${day}::date`)
    .executeTakeFirst();
  await redis().set(k, String(Number(row?.n ?? 0)), "EX", DAY_TTL_SECONDS, "NX");
  return k;
}

async function used(userId: string, day: string, what: "tokens" | "images"): Promise<number> {
  return Number((await redis().get(await seeded(userId, day, what))) ?? 0);
}

/** Today's use against the allowance. */
export async function usageOf(userId: string): Promise<Usage> {
  const day = utcDay();
  const [limits, tokens, images] = await Promise.all([limitsFor(userId), used(userId, day, "tokens"), used(userId, day, "images")]);
  return {
    day,
    tokens: { used: tokens, limit: limits.dailyTokens },
    images: { used: images, limit: limits.dailyImages },
    maxFileMb: limits.maxFileMb,
    resetsAt: nextUtcMidnight().toISOString(),
  };
}

export class QuotaExceededError extends Error {
  constructor(readonly what: "tokens" | "images") {
    super(what === "tokens" ? "You have used today's message allowance" : "You have used today's image allowance");
  }
}

/** Throws QuotaExceededError when today's weighted tokens already reached the limit. */
export async function assertTokensLeft(userId: string): Promise<void> {
  const { dailyTokens } = await limitsFor(userId);
  if (dailyTokens === null) return;
  if ((await used(userId, utcDay(), "tokens")) >= dailyTokens) throw new QuotaExceededError("tokens");
}

/** As an HTTP error, for routes that are not turns (image studio). */
export function quotaHttpError(err: QuotaExceededError) {
  const e = tooMany(err.message);
  return Object.assign(e, { code: "QUOTA_EXCEEDED" as const });
}

// Atomically add ARGV[1] unless the result would pass ARGV[2] (-1 = no limit).
const RESERVE = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local add = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if limit >= 0 and cur + add > limit then return -1 end
local v = redis.call('INCRBY', KEYS[1], add)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return v`;

/** Reserve `count` images for today, or throw QuotaExceededError. Pair with releaseImages on failure. */
export async function reserveImages(userId: string, count: number): Promise<void> {
  const { dailyImages } = await limitsFor(userId);
  const k = await seeded(userId, utcDay(), "images");
  const res = Number(await redis().eval(RESERVE, 1, k, count, dailyImages ?? -1, DAY_TTL_SECONDS));
  if (res < 0) throw new QuotaExceededError("images");
}

export async function releaseImages(userId: string, count: number): Promise<void> {
  const k = key(userId, utcDay(), "images");
  await redis().decrby(k, count);
}

/** Weighted tokens for a model: raw tokens times the model weight, rounded up. */
export function weighted(inputTokens: number, outputTokens: number, weight: number): number {
  return Math.ceil((inputTokens + outputTokens) * weight);
}

export interface UsageRecord {
  userId: string;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  weightedTokens?: number;
  messages?: number;
  images?: number;
  toolCalls?: number;
}

/**
 * Charge a finished turn or image: Redis for the live counters, usage_daily for the
 * record. Counts only (ADR 0012). Images were already counted in Redis by reserveImages.
 */
export async function recordUsage(u: UsageRecord, exec: Executor = db): Promise<void> {
  const day = utcDay();
  const weightedTokens = u.weightedTokens ?? 0;
  if (weightedTokens > 0) {
    const k = await seeded(u.userId, day, "tokens");
    await redis().multi().incrby(k, weightedTokens).expire(k, DAY_TTL_SECONDS).exec();
  }
  await exec
    .insertInto("usage_daily")
    .values({
      user_id: u.userId,
      day: sql<Date>`${day}::date`,
      model_id: u.modelId,
      messages: u.messages ?? 0,
      input_tokens: u.inputTokens ?? 0,
      output_tokens: u.outputTokens ?? 0,
      weighted_tokens: weightedTokens,
      images: u.images ?? 0,
      tool_calls: u.toolCalls ?? 0,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "day", "model_id"]).doUpdateSet((eb) => ({
        messages: eb("usage_daily.messages", "+", eb.ref("excluded.messages")),
        input_tokens: eb("usage_daily.input_tokens", "+", eb.ref("excluded.input_tokens")),
        output_tokens: eb("usage_daily.output_tokens", "+", eb.ref("excluded.output_tokens")),
        weighted_tokens: eb("usage_daily.weighted_tokens", "+", eb.ref("excluded.weighted_tokens")),
        images: eb("usage_daily.images", "+", eb.ref("excluded.images")),
        tool_calls: eb("usage_daily.tool_calls", "+", eb.ref("excluded.tool_calls")),
      })),
    )
    .execute();
}

