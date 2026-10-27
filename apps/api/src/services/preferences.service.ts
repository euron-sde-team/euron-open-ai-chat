/** Per-user preferences that shape every answer (custom instructions, answer style, memory switch, default model, voice). */
import type { AnswerStyle, Preferences } from "@open-chat/types";
import { type Actor, requireActive } from "../core/context";
import { badRequest } from "../core/errors";
import { db, type Executor } from "../db/kysely";
import { VOICES } from "../integrations/speech";
import { catalog } from "./models.service";
import { getSettings } from "./settings.service";

export async function preferencesOf(userId: string, exec: Executor = db): Promise<Preferences> {
  const row = await exec.selectFrom("user_preferences").selectAll().where("user_id", "=", userId).executeTakeFirst();
  const settings = await getSettings(exec);
  return {
    aboutMe: row?.about_me ?? "",
    customInstructions: row?.custom_instructions ?? "",
    answerStyle: (row?.answer_style ?? settings.defaults.answerStyle) as AnswerStyle,
    memoryEnabled: row?.memory_enabled ?? true,
    webSearchDefault: row?.web_search_default ?? true,
    defaultModelId: row?.default_model_id ?? null,
    voice: row?.voice ?? "alloy",
  };
}

export async function updatePreferences(actor: Actor, patch: Partial<Preferences>): Promise<Preferences> {
  requireActive(actor);
  if (patch.defaultModelId) {
    const { chat } = await catalog();
    if (!chat.some((m) => m.id === patch.defaultModelId)) throw badRequest("That model is not available", "MODEL_UNAVAILABLE");
  }
  if (patch.voice && !(VOICES as readonly string[]).includes(patch.voice)) throw badRequest("Unknown voice", "VOICE_UNKNOWN");
  const values = {
    ...(patch.aboutMe !== undefined ? { about_me: patch.aboutMe } : {}),
    ...(patch.customInstructions !== undefined ? { custom_instructions: patch.customInstructions } : {}),
    ...(patch.answerStyle !== undefined ? { answer_style: patch.answerStyle } : {}),
    ...(patch.memoryEnabled !== undefined ? { memory_enabled: patch.memoryEnabled } : {}),
    ...(patch.webSearchDefault !== undefined ? { web_search_default: patch.webSearchDefault } : {}),
    ...(patch.defaultModelId !== undefined ? { default_model_id: patch.defaultModelId } : {}),
    ...(patch.voice !== undefined ? { voice: patch.voice } : {}),
  };
  await db
    .insertInto("user_preferences")
    .values({ user_id: actor.id, ...values })
    .onConflict((oc) => oc.column("user_id").doUpdateSet({ ...values, updated_at: new Date() }))
    .execute();
  return preferencesOf(actor.id);
}
