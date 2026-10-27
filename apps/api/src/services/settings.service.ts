/**
 * Deployment settings: one JSON document in the `settings` table, merged over the
 * defaults below, cached for a few seconds per process. Admins edit it through
 * /api/admin/settings; every save is audited with the before and after values.
 */
import type { ChatSettings } from "@open-chat/types";
import { config } from "../core/config";
import { db, type Executor } from "../db/kysely";

export const DEFAULT_SETTINGS: ChatSettings = {
  appName: config.PRODUCT_NAME,
  tagline: "A private AI assistant for your team.",
  registration: "OPEN",
  allowedEmailDomains: [],
  supportEmail: null,
  systemPromptAddendum: "",
  features: { webSearch: true, imageGeneration: true, dictation: true, readAloud: true, memory: true, projects: true, sharing: true },
  defaults: { answerStyle: "BALANCED" },
  retentionDays: null,
  minSupportedVersion: null,
};

const TTL_MS = 5_000;
let cache: { at: number; value: ChatSettings } | null = null;

/** Groups merge key by key, so a stored document from an older release keeps working. */
export function mergeSettings(base: ChatSettings, stored: Partial<ChatSettings>): ChatSettings {
  return {
    ...base,
    ...stored,
    features: { ...base.features, ...(stored.features ?? {}) },
    defaults: { ...base.defaults, ...(stored.defaults ?? {}) },
  };
}

export async function getSettings(exec: Executor = db): Promise<ChatSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const row = await exec.selectFrom("settings").select("value").where("key", "=", "app").executeTakeFirst();
  const value = mergeSettings(DEFAULT_SETTINGS, (row?.value as Partial<ChatSettings>) ?? {});
  cache = { at: Date.now(), value };
  return value;
}

export async function saveSettings(patch: Partial<ChatSettings>, actorId: string | null, exec: Executor = db): Promise<{ before: ChatSettings; after: ChatSettings }> {
  const before = await getSettings(exec);
  const after = mergeSettings(before, patch);
  await exec
    .insertInto("settings")
    .values({ key: "app", value: JSON.stringify(after), updated_by: actorId })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(after), updated_by: actorId, updated_at: new Date() }))
    .execute();
  cache = null;
  return { before, after };
}

export function clearSettingsCache(): void {
  cache = null;
}

/** The name to show for this deployment (emails, page titles). */
export async function appName(exec: Executor = db): Promise<string> {
  return (await getSettings(exec)).appName?.trim() || config.PRODUCT_NAME;
}
