/**
 * Optional input moderation (MODERATION_PROVIDER). Off by default: most private
 * deployments rely on the model providers' own safety systems. When on, prompts and image
 * prompts are checked before they reach a model, and a flagged one ends the turn with
 * CONTENT_BLOCKED. A moderation outage fails open (logged): it must not take chat down.
 */
import { config, providerKey } from "../../core/config";
import { logger } from "../../core/logger";
import { providerFetch, withTimeout } from "../http";

export interface ModerationResult {
  flagged: boolean;
  categories: string[];
}

export async function moderate(text: string): Promise<ModerationResult> {
  if (config.MODERATION_PROVIDER === "none" || !text.trim()) return { flagged: false, categories: [] };
  try {
    const base = config.MODERATION_PROVIDER === "stub" ? `${config.STUBS_URL.replace(/\/$/, "")}/v1` : "https://api.openai.com/v1";
    const key = config.MODERATION_PROVIDER === "openai" ? providerKey("openai") : null;
    if (config.MODERATION_PROVIDER === "openai" && !key) return { flagged: false, categories: [] };
    const res = await providerFetch("moderation", `${base}/moderations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text.slice(0, 20_000) }),
      signal: withTimeout(undefined, 10_000),
    });
    const json = (await res.json()) as { results?: { flagged?: boolean; categories?: Record<string, boolean> }[] };
    const r = json.results?.[0];
    return { flagged: !!r?.flagged, categories: Object.entries(r?.categories ?? {}).filter(([, v]) => v).map(([k]) => k) };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "moderation unavailable; allowing");
    return { flagged: false, categories: [] };
  }
}
