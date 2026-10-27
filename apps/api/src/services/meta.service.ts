/** GET /api/meta: what a client needs before anyone signs in. Never a key, never a provider name. */
import type { AppMeta } from "@open-chat/types";
import { config, searchConfigured } from "../core/config";
import { ATTACHMENT_MIME_TYPES } from "../domain/file-rules";
import { db } from "../db/kysely";
import { MAX_FILES_PER_MESSAGE, MAX_MESSAGE_CHARS } from "./chat/chat.service";
import { catalog, resolveKind } from "./models.service";
import { getSettings } from "./settings.service";

export async function appMeta(): Promise<AppMeta> {
  const [s, models, tier, transcribe, speech] = await Promise.all([
    getSettings(),
    catalog(),
    db.selectFrom("quota_tiers").select("max_file_mb").where("is_default", "=", true).executeTakeFirst(),
    resolveKind("TRANSCRIBE"),
    resolveKind("SPEECH"),
  ]);
  return {
    appName: s.appName,
    tagline: s.tagline,
    registration: s.registration,
    features: {
      webSearch: s.features.webSearch && searchConfigured(config),
      imageGeneration: s.features.imageGeneration && !!models.imageModel,
      dictation: s.features.dictation && !!transcribe,
      readAloud: s.features.readAloud && !!speech,
      memory: s.features.memory,
      projects: s.features.projects,
      sharing: s.features.sharing,
    },
    limits: { maxFileMb: tier?.max_file_mb ?? 25, maxFilesPerMessage: MAX_FILES_PER_MESSAGE, maxMessageChars: MAX_MESSAGE_CHARS, acceptedMimeTypes: ATTACHMENT_MIME_TYPES },
    support: { email: s.supportEmail },
    minSupportedVersion: s.minSupportedVersion,
  };
}
