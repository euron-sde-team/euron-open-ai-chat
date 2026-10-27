/**
 * The /admin control plane (admins only, ACTIVE accounts only). Every change is audited
 * in the same transaction as the change.
 *
 * Admins never see conversation content: there is no "read a user's chats" endpoint.
 * They see accounts, counts and usage, shared links (which their owners made public),
 * and the configuration.
 */
import type {
  AdminModel,
  AdminProvider,
  AdminShareRow,
  AdminStats,
  AdminUserDetail,
  AdminUserRow,
  ChatSettings,
  IntegrationStatus,
  ModelTestResult,
  Page,
  QuotaTier,
  UserRole,
} from "@open-chat/types";
import { sql } from "kysely";
import { config, providerKeys, searchConfigured } from "../core/config";
import { type Actor, type RequestMeta, requireAdmin } from "../core/context";
import { withTransaction } from "../core/effects";
import { badRequest, conflict, forbidden, notFound } from "../core/errors";
import { newId } from "../core/ids";
import { db, type Executor } from "../db/kysely";
import { ProviderError } from "../integrations/http";
import { storage } from "../integrations/storage";
import { loadSummaries } from "../presenters/user.presenter";
import { atKey, decodeTime, olderThan, timePage } from "../repositories/keyset";
import { sessionRepo } from "../repositories/session.repository";
import { userRepo } from "../repositories/user.repository";
import { anonymiseUser, assertNotLastAdmin } from "./account.service";
import { audit } from "./audit.service";
import { clearModelCache, endpointFor, findModel } from "./models.service";
import { utcDay } from "./quota.service";
import { shareUrl } from "./share.service";
import { clearSettingsCache, getSettings, mergeSettings, saveSettings } from "./settings.service";
import { adapterFor } from "../integrations/llm";

// ─── Overview ───────────────────────────────────────────────────────────────

export async function stats(actor: Actor, from: string, to: string): Promise<AdminStats> {
  requireAdmin(actor);
  const range = (col: string) => sql<boolean>`${sql.ref(col)} >= ${from}::date AND ${sql.ref(col)} < (${to}::date + 1)`;
  const [users, newUsers, convos, msgs, usage, daily, byModel, feedback] = await Promise.all([
    db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).where("status", "<>", "DEACTIVATED").executeTakeFirstOrThrow(),
    db.selectFrom("users").select((eb) => eb.fn.countAll<string>().as("n")).where(range("created_at")).executeTakeFirstOrThrow(),
    db.selectFrom("conversations").select((eb) => eb.fn.countAll<string>().as("n")).where(range("created_at")).executeTakeFirstOrThrow(),
    db.selectFrom("messages").select((eb) => eb.fn.countAll<string>().as("n")).where("role", "=", "USER").where(range("created_at")).executeTakeFirstOrThrow(),
    db
      .selectFrom("usage_daily")
      .select([sql<string>`count(DISTINCT user_id)`.as("active"), sql<string>`coalesce(sum(images), 0)`.as("images"), sql<string>`coalesce(sum(weighted_tokens), 0)`.as("weighted")])
      .where(range("day"))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("usage_daily")
      .select([sql<string>`to_char(day, 'YYYY-MM-DD')`.as("date"), sql<string>`count(DISTINCT user_id)`.as("active"), sql<string>`sum(messages)`.as("messages"), sql<string>`sum(images)`.as("images"), sql<string>`sum(weighted_tokens)`.as("weighted")])
      .where(range("day"))
      .groupBy("day")
      .orderBy("day")
      .execute(),
    db
      .selectFrom("usage_daily as u")
      .innerJoin("models as m", "m.id", "u.model_id")
      .select(["u.model_id", "m.display_name", sql<string>`sum(u.messages)`.as("messages"), sql<string>`sum(u.input_tokens)`.as("input"), sql<string>`sum(u.output_tokens)`.as("output")])
      .where(range("u.day"))
      .groupBy(["u.model_id", "m.display_name"])
      .orderBy(sql`sum(u.messages)`, "desc")
      .execute(),
    db
      .selectFrom("messages")
      .select([sql<string>`count(*) FILTER (WHERE feedback = 1)`.as("up"), sql<string>`count(*) FILTER (WHERE feedback = -1)`.as("down")])
      .where(range("created_at"))
      .executeTakeFirstOrThrow(),
  ]);
  const n = (v: string | number | null | undefined) => Number(v ?? 0);
  return {
    from,
    to,
    totals: { users: n(users.n), newUsers: n(newUsers.n), activeUsers: n(usage.active), conversations: n(convos.n), messages: n(msgs.n), images: n(usage.images), weightedTokens: n(usage.weighted) },
    daily: daily.map((d) => ({ date: d.date, activeUsers: n(d.active), messages: n(d.messages), images: n(d.images), weightedTokens: n(d.weighted) })),
    byModel: byModel.map((m) => ({ modelId: m.model_id, displayName: m.display_name, messages: n(m.messages), inputTokens: n(m.input), outputTokens: n(m.output) })),
    feedback: { up: n(feedback.up), down: n(feedback.down) },
  };
}

// ─── Users ──────────────────────────────────────────────────────────────────

function userRows(exec: Executor = db) {
  return exec
    .selectFrom("users as u")
    .leftJoin("quota_tiers as t", "t.id", "u.quota_tier_id")
    .select(["u.id", "u.username", "u.display_name", "u.role", "u.avatar_file_id", "u.email", "u.status", "u.created_at", "u.last_seen_at", "u.suspended_until", "t.id as tier_id", "t.name as tier_name"])
    .select(sql<string>`(SELECT coalesce(sum(weighted_tokens), 0) FROM usage_daily d WHERE d.user_id = u.id AND d.day = ${utcDay()}::date)`.as("tokens_today"));
}

type UserRowDb = Awaited<ReturnType<ReturnType<typeof userRows>["executeTakeFirstOrThrow"]>>;

async function toAdminRows(rows: UserRowDb[], exec: Executor = db): Promise<AdminUserRow[]> {
  const people = await loadSummaries(rows.map((r) => r.id), exec);
  return rows.map((r) => ({
    ...people.get(r.id)!,
    email: r.email,
    status: r.status,
    quotaTier: r.tier_id ? { id: r.tier_id, name: r.tier_name! } : null,
    createdAt: r.created_at.toISOString(),
    lastSeenAt: r.last_seen_at?.toISOString() ?? null,
    suspendedUntil: r.suspended_until?.toISOString() ?? null,
    tokensToday: Number(r.tokens_today),
  }));
}

export async function listUsers(actor: Actor, q: { q?: string; status?: string; role?: UserRole; tierId?: string; cursor?: string; limit: number }): Promise<Page<AdminUserRow>> {
  requireAdmin(actor);
  let query = userRows().select(atKey("u.created_at"));
  if (q.q?.trim()) query = query.where(sql<boolean>`(u.display_name || ' ' || u.username::text || ' ' || u.email::text) ILIKE ${`%${q.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`}`);
  if (q.status) query = query.where("u.status", "=", q.status as AdminUserRow["status"]);
  if (q.role) query = query.where("u.role", "=", q.role);
  if (q.tierId) query = query.where("u.quota_tier_id", "=", q.tierId);
  const rows = await query.where(olderThan("u.created_at", "u.id", decodeTime(q.cursor))).orderBy("u.created_at", "desc").orderBy("u.id", "desc").limit(q.limit + 1).execute();
  const page = timePage(rows, q.limit);
  return { items: await toAdminRows(page.items), nextCursor: page.nextCursor };
}

export async function userDetail(actor: Actor, id: string): Promise<AdminUserDetail> {
  requireAdmin(actor);
  const row = await userRows().where("u.id", "=", id).executeTakeFirst();
  if (!row) throw notFound("User not found", "USER_NOT_FOUND");
  const [base] = await toAdminRows([row]);
  const [override, totals, usage] = await Promise.all([
    db.selectFrom("user_quota_overrides").selectAll().where("user_id", "=", id).executeTakeFirst(),
    db
      .selectNoFrom([
        sql<string>`(SELECT count(*) FROM conversations WHERE user_id = ${id})`.as("conversations"),
        sql<string>`(SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ${id} AND m.role = 'USER')`.as("messages"),
        sql<string>`(SELECT count(*) FROM images WHERE user_id = ${id})`.as("images"),
        sql<string>`(SELECT count(*) FROM files WHERE owner_id = ${id} AND status <> 'DELETED')`.as("files"),
      ])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("usage_daily")
      .select([sql<string>`to_char(day, 'YYYY-MM-DD')`.as("date"), sql<string>`sum(weighted_tokens)`.as("w"), sql<string>`sum(images)`.as("i")])
      .where("user_id", "=", id)
      .where(sql<boolean>`day > current_date - 30`)
      .groupBy("day")
      .orderBy("day")
      .execute(),
  ]);
  return {
    ...base!,
    override: override ? { dailyTokens: override.daily_tokens === null ? null : Number(override.daily_tokens), dailyImages: override.daily_images, note: override.note, updatedAt: override.updated_at.toISOString() } : null,
    totals: { conversations: Number(totals.conversations), messages: Number(totals.messages), images: Number(totals.images), files: Number(totals.files) },
    usage: usage.map((u) => ({ date: u.date, weightedTokens: Number(u.w), images: Number(u.i) })),
  };
}

async function target(actor: Actor, id: string, exec: Executor = db) {
  const user = await userRepo.findById(id, exec);
  if (!user) throw notFound("User not found", "USER_NOT_FOUND");
  if (user.id === actor.id) throw forbidden("You cannot do that to your own account", "SELF_ACTION");
  return user;
}

export async function setRole(actor: Actor, id: string, role: UserRole, meta: RequestMeta): Promise<AdminUserRow> {
  requireAdmin(actor);
  return withTransaction(async (trx) => {
    const user = await target(actor, id, trx);
    if (user.role === role) return (await toAdminRows([await userRows(trx).where("u.id", "=", id).executeTakeFirstOrThrow()], trx))[0]!;
    if (user.role === "ADMIN") await assertNotLastAdmin(user.id, "ADMIN", trx);
    await trx.updateTable("users").set({ role, updated_at: new Date() }).where("id", "=", id).execute();
    // A demoted admin's open sessions must not keep admin powers until the token expires.
    if (role !== "ADMIN") await userRepo.bumpTokenVersion(id, trx);
    await audit({ actorId: actor.id, action: "user.role", entityType: "user", entityId: id, ip: meta.ip, data: { from: user.role, to: role } }, trx);
    return (await toAdminRows([await userRows(trx).where("u.id", "=", id).executeTakeFirstOrThrow()], trx))[0]!;
  });
}

export async function setStatus(actor: Actor, id: string, action: "suspend" | "unsuspend" | "ban" | "unban", input: { days?: number; reason?: string }, meta: RequestMeta): Promise<AdminUserRow> {
  requireAdmin(actor);
  return withTransaction(async (trx) => {
    const user = await target(actor, id, trx);
    if (user.status === "DEACTIVATED") throw conflict("This account was erased", "USER_ERASED");
    const now = new Date();
    if (action === "suspend") {
      if (!input.days || input.days < 1 || input.days > 365) throw badRequest("Suspend for 1 to 365 days", "DAYS_INVALID");
      if (user.role === "ADMIN") throw forbidden("Demote an admin before suspending them", "TARGET_PROTECTED");
      await trx.updateTable("users").set({ status: "SUSPENDED", suspended_until: new Date(now.getTime() + input.days * 86_400_000), updated_at: now }).where("id", "=", id).execute();
    } else if (action === "unsuspend") {
      if (user.status !== "SUSPENDED") throw conflict("This account is not suspended", "INVALID_STATUS");
      await trx.updateTable("users").set({ status: "ACTIVE", suspended_until: null, updated_at: now }).where("id", "=", id).execute();
    } else if (action === "ban") {
      if (user.role === "ADMIN") throw forbidden("Demote an admin before banning them", "TARGET_PROTECTED");
      await trx.updateTable("users").set({ status: "BANNED", suspended_until: null, updated_at: now }).where("id", "=", id).execute();
      await sessionRepo.revokeAllForUser(id, trx);
      await userRepo.bumpTokenVersion(id, trx);
      await trx.updateTable("shares").set({ revoked_at: now, revoked_by: actor.id }).where("user_id", "=", id).where("revoked_at", "is", null).execute();
    } else {
      if (user.status !== "BANNED") throw conflict("This account is not banned", "INVALID_STATUS");
      await trx.updateTable("users").set({ status: "ACTIVE", updated_at: now }).where("id", "=", id).execute();
    }
    await audit({ actorId: actor.id, action: `user.${action}`, entityType: "user", entityId: id, ip: meta.ip, data: { reason: input.reason ?? null, days: input.days ?? null } }, trx);
    return (await toAdminRows([await userRows(trx).where("u.id", "=", id).executeTakeFirstOrThrow()], trx))[0]!;
  });
}

export async function eraseUser(actor: Actor, id: string, reason: string, meta: RequestMeta): Promise<void> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    const user = await target(actor, id, trx);
    if (user.status === "DEACTIVATED") throw conflict("This account was already erased", "ALREADY_ERASED");
    await assertNotLastAdmin(user.id, user.role, trx);
    await anonymiseUser(id, trx);
    await audit({ actorId: actor.id, action: "user.erase", entityType: "user", entityId: id, ip: meta.ip, data: { reason } }, trx);
  });
}

export async function setUserTier(actor: Actor, id: string, tierId: string | null, meta: RequestMeta): Promise<AdminUserRow> {
  requireAdmin(actor);
  return withTransaction(async (trx) => {
    const user = await userRepo.findById(id, trx);
    if (!user) throw notFound("User not found", "USER_NOT_FOUND");
    if (tierId && !(await trx.selectFrom("quota_tiers").select("id").where("id", "=", tierId).executeTakeFirst())) throw notFound("Tier not found", "TIER_NOT_FOUND");
    await trx.updateTable("users").set({ quota_tier_id: tierId, updated_at: new Date() }).where("id", "=", id).execute();
    await audit({ actorId: actor.id, action: "user.tier", entityType: "user", entityId: id, ip: meta.ip, data: { from: user.quota_tier_id, to: tierId } }, trx);
    return (await toAdminRows([await userRows(trx).where("u.id", "=", id).executeTakeFirstOrThrow()], trx))[0]!;
  });
}

/** Set one account's own limits, or remove them with `null` (DELETE /api/admin/users/:id/quota). */
export async function setOverride(actor: Actor, id: string, input: { dailyTokens: number | null; dailyImages: number | null; note: string | null } | null, meta: RequestMeta): Promise<AdminUserDetail> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    if (!(await userRepo.findById(id, trx))) throw notFound("User not found", "USER_NOT_FOUND");
    if (input === null) await trx.deleteFrom("user_quota_overrides").where("user_id", "=", id).execute();
    else {
      const values = { daily_tokens: input.dailyTokens, daily_images: input.dailyImages, note: input.note, updated_by: actor.id, updated_at: new Date() };
      await trx.insertInto("user_quota_overrides").values({ user_id: id, ...values }).onConflict((oc) => oc.column("user_id").doUpdateSet(values)).execute();
    }
    await audit({ actorId: actor.id, action: input ? "user.quota_override" : "user.quota_override_removed", entityType: "user", entityId: id, ip: meta.ip, data: input ?? {} }, trx);
  });
  return userDetail(actor, id);
}

// ─── Quota tiers ────────────────────────────────────────────────────────────

export async function listTiers(actor: Actor): Promise<QuotaTier[]> {
  requireAdmin(actor);
  const rows = await db
    .selectFrom("quota_tiers as t")
    .selectAll("t")
    .select(sql<string>`(SELECT count(*) FROM users u WHERE u.quota_tier_id = t.id OR (u.quota_tier_id IS NULL AND t.is_default))`.as("users"))
    .orderBy("t.is_default", "desc")
    .orderBy("t.name")
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name, dailyTokens: r.daily_tokens === null ? null : Number(r.daily_tokens), dailyImages: r.daily_images, maxFileMb: r.max_file_mb, isDefault: r.is_default, userCount: Number(r.users) }));
}

export interface TierInput {
  name: string;
  dailyTokens: number | null;
  dailyImages: number | null;
  maxFileMb: number;
  isDefault?: boolean;
}

export async function saveTier(actor: Actor, id: string | null, input: TierInput, meta: RequestMeta): Promise<QuotaTier[]> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    if (input.isDefault) await trx.updateTable("quota_tiers").set({ is_default: false }).where("is_default", "=", true).execute();
    const values = { name: input.name.trim(), daily_tokens: input.dailyTokens, daily_images: input.dailyImages, max_file_mb: input.maxFileMb, ...(input.isDefault ? { is_default: true } : {}), updated_at: new Date() };
    const clash = await trx.selectFrom("quota_tiers").select("id").where("name", "=", values.name).where("id", "<>", id ?? "").executeTakeFirst();
    if (clash) throw conflict("A tier with this name exists", "TIER_NAME_TAKEN");
    if (id) {
      const res = await trx.updateTable("quota_tiers").set(values).where("id", "=", id).executeTakeFirst();
      if (!Number(res.numUpdatedRows)) throw notFound("Tier not found", "TIER_NOT_FOUND");
    } else {
      id = newId();
      await trx.insertInto("quota_tiers").values({ id, ...values }).execute();
    }
    if (!(await trx.selectFrom("quota_tiers").select("id").where("is_default", "=", true).executeTakeFirst())) throw badRequest("One tier must be the default", "TIER_DEFAULT_REQUIRED");
    await audit({ actorId: actor.id, action: "tier.save", entityType: "quota_tier", entityId: id, ip: meta.ip, data: { ...input } }, trx);
  });
  return listTiers(actor);
}

export async function deleteTier(actor: Actor, id: string, meta: RequestMeta): Promise<QuotaTier[]> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    const tier = await trx.selectFrom("quota_tiers").select(["is_default"]).where("id", "=", id).executeTakeFirst();
    if (!tier) throw notFound("Tier not found", "TIER_NOT_FOUND");
    if (tier.is_default) throw conflict("Make another tier the default first", "TIER_IS_DEFAULT");
    // Its users fall back to the default tier (ON DELETE SET NULL).
    await trx.deleteFrom("quota_tiers").where("id", "=", id).execute();
    await audit({ actorId: actor.id, action: "tier.delete", entityType: "quota_tier", entityId: id, ip: meta.ip }, trx);
  });
  return listTiers(actor);
}

// ─── Providers and models ───────────────────────────────────────────────────

export async function listProviders(actor: Actor): Promise<AdminProvider[]> {
  requireAdmin(actor);
  const rows = await db.selectFrom("providers as p").selectAll("p").select(sql<string>`(SELECT count(*) FROM models m WHERE m.provider_id = p.id)`.as("models")).orderBy("p.display_name").execute();
  const keys = providerKeys();
  return rows.map((p) => ({ id: p.id, kind: p.kind, displayName: p.display_name, baseUrl: p.base_url, enabled: p.enabled, keyConfigured: !!keys[p.id] || p.kind === "STUB", modelCount: Number(p.models) }));
}

export interface ProviderInput {
  id: string;
  kind: AdminProvider["kind"];
  displayName: string;
  baseUrl: string | null;
  enabled: boolean;
}

export async function saveProvider(actor: Actor, input: ProviderInput, isNew: boolean, meta: RequestMeta): Promise<AdminProvider[]> {
  requireAdmin(actor);
  if (input.kind === "OPENAI_COMPATIBLE" && !input.baseUrl) throw badRequest("An OpenAI-compatible provider needs a base URL", "BASE_URL_REQUIRED");
  if (input.baseUrl && !/^https?:\/\//i.test(input.baseUrl)) throw badRequest("The base URL must be http(s)", "BASE_URL_INVALID");
  if (input.kind === "STUB" && config.NODE_ENV === "production") throw badRequest("Stub providers are for development", "STUB_IN_PRODUCTION");
  await withTransaction(async (trx) => {
    const values = { kind: input.kind, display_name: input.displayName.trim(), base_url: input.baseUrl?.trim() || null, enabled: input.enabled, updated_at: new Date() };
    if (isNew) {
      if (await trx.selectFrom("providers").select("id").where("id", "=", input.id).executeTakeFirst()) throw conflict("A provider with this slug exists", "PROVIDER_SLUG_TAKEN");
      await trx.insertInto("providers").values({ id: input.id, ...values }).execute();
    } else {
      const res = await trx.updateTable("providers").set(values).where("id", "=", input.id).executeTakeFirst();
      if (!Number(res.numUpdatedRows)) throw notFound("Provider not found", "PROVIDER_NOT_FOUND");
    }
    await audit({ actorId: actor.id, action: isNew ? "provider.create" : "provider.update", entityType: "provider", entityId: input.id, ip: meta.ip, data: { ...input } }, trx);
  });
  clearModelCache();
  return listProviders(actor);
}

export async function deleteProvider(actor: Actor, id: string, meta: RequestMeta): Promise<AdminProvider[]> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    const res = await trx.deleteFrom("providers").where("id", "=", id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw notFound("Provider not found", "PROVIDER_NOT_FOUND");
    await audit({ actorId: actor.id, action: "provider.delete", entityType: "provider", entityId: id, ip: meta.ip }, trx);
  });
  clearModelCache();
  return listProviders(actor);
}

type ModelDb = Awaited<ReturnType<typeof listModelRows>>[number];
const listModelRows = () => db.selectFrom("models").selectAll().orderBy("kind").orderBy("sort_order").orderBy("display_name").execute();

function toAdminModel(m: ModelDb): AdminModel {
  return {
    id: m.id,
    providerId: m.provider_id,
    kind: m.kind,
    modelRef: m.model_ref,
    displayName: m.display_name,
    description: m.description,
    supportsVision: m.supports_vision,
    supportsTools: m.supports_tools,
    supportsReasoning: m.supports_reasoning,
    contextWindow: m.context_window,
    maxOutputTokens: m.max_output_tokens,
    weight: Number(m.weight),
    enabled: m.enabled,
    isDefault: m.is_default,
    sortOrder: m.sort_order,
  };
}

export async function listModels(actor: Actor): Promise<AdminModel[]> {
  requireAdmin(actor);
  return (await listModelRows()).map(toAdminModel);
}

export type ModelInput = Omit<AdminModel, "id">;

export async function saveModel(actor: Actor, id: string | null, input: ModelInput, meta: RequestMeta): Promise<AdminModel[]> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    if (!(await trx.selectFrom("providers").select("id").where("id", "=", input.providerId).executeTakeFirst())) throw notFound("Provider not found", "PROVIDER_NOT_FOUND");
    if (input.isDefault) await trx.updateTable("models").set({ is_default: false }).where("kind", "=", input.kind).where("is_default", "=", true).execute();
    const values = {
      provider_id: input.providerId,
      kind: input.kind,
      model_ref: input.modelRef.trim(),
      display_name: input.displayName.trim(),
      description: input.description.trim(),
      supports_vision: input.supportsVision,
      supports_tools: input.supportsTools,
      supports_reasoning: input.supportsReasoning,
      context_window: input.contextWindow,
      max_output_tokens: input.maxOutputTokens,
      weight: input.weight,
      enabled: input.enabled,
      is_default: input.isDefault,
      sort_order: input.sortOrder,
      updated_at: new Date(),
    };
    if (id) {
      const res = await trx.updateTable("models").set(values).where("id", "=", id).executeTakeFirst();
      if (!Number(res.numUpdatedRows)) throw notFound("Model not found", "MODEL_NOT_FOUND");
    } else {
      id = newId();
      await trx.insertInto("models").values({ id, ...values }).execute();
    }
    await audit({ actorId: actor.id, action: "model.save", entityType: "model", entityId: id, ip: meta.ip, data: { ...input } }, trx);
  }).catch((err: { code?: string }) => {
    if (err.code === "23505") throw conflict("This provider already has that model of that kind", "MODEL_DUPLICATE");
    throw err;
  });
  clearModelCache();
  return listModels(actor);
}

export async function deleteModel(actor: Actor, id: string, meta: RequestMeta): Promise<AdminModel[]> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    const res = await trx.deleteFrom("models").where("id", "=", id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw notFound("Model not found", "MODEL_NOT_FOUND");
    await audit({ actorId: actor.id, action: "model.delete", entityType: "model", entityId: id, ip: meta.ip }, trx);
  });
  clearModelCache();
  return listModels(actor);
}

/** One tiny call through the real provider, to check a key and a model id. The result never contains the key or the provider's error text. */
export async function testModel(actor: Actor, id: string): Promise<ModelTestResult> {
  requireAdmin(actor);
  const found = await findModel(id);
  if (!found) throw notFound("Model not found", "MODEL_NOT_FOUND");
  const endpoint = endpointFor(found.provider);
  if (!endpoint) return { ok: false, latencyMs: 0, message: "No key is configured for this provider on the server." };
  if (found.model.kind !== "CHAT") return { ok: true, latencyMs: 0, message: "Configured. Only chat models can be tested with a call." };
  const started = Date.now();
  try {
    let text = "";
    for await (const ev of adapterFor(found.provider.kind).stream({ model: found.model.model_ref, maxOutputTokens: 16, messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }] }] }, endpoint)) {
      if (ev.type === "text") text += ev.text;
    }
    return { ok: true, latencyMs: Date.now() - started, message: text.trim() ? "The model answered." : "The call worked but the model returned no text." };
  } catch (err) {
    const failure = err instanceof ProviderError ? err.failure : "UNAVAILABLE";
    const messages: Record<string, string> = {
      AUTH: "The provider rejected the key.",
      RATE_LIMITED: "The provider is rate limiting this key.",
      BAD_REQUEST: "The provider refused the request: check the model id.",
      TIMEOUT: "The provider did not answer in time.",
      UNAVAILABLE: "The provider could not be reached or had an error.",
      CONTEXT_TOO_LONG: "The provider refused the request.",
      CONTENT_FILTER: "The provider refused the request.",
    };
    return { ok: false, latencyMs: Date.now() - started, message: messages[failure] ?? messages.UNAVAILABLE! };
  }
}

// ─── Settings ───────────────────────────────────────────────────────────────

export type SettingsPatch = { [K in keyof ChatSettings]?: ChatSettings[K] extends Record<string, unknown> ? Partial<ChatSettings[K]> : ChatSettings[K] };

export async function readSettings(actor: Actor): Promise<ChatSettings> {
  requireAdmin(actor);
  return getSettings();
}

export async function updateSettings(actor: Actor, patch: SettingsPatch, meta: RequestMeta): Promise<ChatSettings> {
  requireAdmin(actor);
  return withTransaction(async (trx) => {
    clearSettingsCache();
    const input = patch as Partial<ChatSettings>;
    const merged = mergeSettings(await getSettings(trx), input);
    if (merged.registration === "INVITE_ONLY" && !merged.allowedEmailDomains.length) throw badRequest("Invite-only sign-up needs at least one allowed email domain", "SETTINGS_INVALID");
    const { before, after } = await saveSettings(input, actor.id, trx);
    const b = before as unknown as Record<string, unknown>;
    const a = after as unknown as Record<string, unknown>;
    const keys = Object.keys(input).filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
    if (keys.length) await audit({ actorId: actor.id, action: "settings.update", entityType: "settings", entityId: "app", ip: meta.ip, data: { keys, before: Object.fromEntries(keys.map((k) => [k, b[k]])), after: Object.fromEntries(keys.map((k) => [k, a[k]])) } }, trx);
    clearSettingsCache();
    return after;
  });
}

export async function integrations(actor: Actor): Promise<IntegrationStatus> {
  requireAdmin(actor);
  const [transcribe, tts] = await Promise.all([
    db.selectFrom("models").select("id").where("kind", "=", "TRANSCRIBE").where("enabled", "=", true).executeTakeFirst(),
    db.selectFrom("models").select("id").where("kind", "=", "SPEECH").where("enabled", "=", true).executeTakeFirst(),
  ]);
  return {
    search: { provider: config.SEARCH_PROVIDER, configured: searchConfigured() },
    moderation: { provider: config.MODERATION_PROVIDER },
    speech: { transcribe: !!transcribe, tts: !!tts },
    mail: { mode: config.MAIL_MODE },
    storage: { mode: storage().mode },
  };
}

// ─── Shares ─────────────────────────────────────────────────────────────────

export async function listAllShares(actor: Actor, q: { cursor?: string; limit: number; includeRevoked?: boolean }): Promise<Page<AdminShareRow>> {
  requireAdmin(actor);
  let query = db.selectFrom("shares").select(["id", "title", "user_id", "view_count", "revoked_at", "created_at"]).select(atKey("created_at"));
  if (!q.includeRevoked) query = query.where("revoked_at", "is", null);
  const rows = await query.where(olderThan("created_at", "id", decodeTime(q.cursor))).orderBy("created_at", "desc").orderBy("id", "desc").limit(q.limit + 1).execute();
  const page = timePage(rows, q.limit);
  const people = await loadSummaries(page.items.map((r) => r.user_id));
  return {
    items: page.items.map((r) => ({ id: r.id, title: r.title, owner: people.get(r.user_id)!, viewCount: r.view_count, revoked: !!r.revoked_at, createdAt: r.created_at.toISOString(), url: shareUrl(r.id) })),
    nextCursor: page.nextCursor,
  };
}

export async function adminRevokeShare(actor: Actor, id: string, reason: string, meta: RequestMeta): Promise<void> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    const res = await trx.updateTable("shares").set({ revoked_at: new Date(), revoked_by: actor.id }).where("id", "=", id).where("revoked_at", "is", null).executeTakeFirst();
    if (!Number(res.numUpdatedRows)) throw notFound("Link not found", "SHARE_NOT_FOUND");
    await audit({ actorId: actor.id, action: "share.revoke", entityType: "share", entityId: id, ip: meta.ip, data: { reason } }, trx);
  });
}
