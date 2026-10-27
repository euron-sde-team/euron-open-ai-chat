/**
 * A starter model catalogue: the providers most people use, with a few current models
 * each, so a new install only needs keys. Model ids change often: edit them in
 * /admin/models (the "Test" button checks one in a second). A provider without a key is
 * simply not offered (services/models.service.ts), so nothing here is visible until its
 * key is set. The stub provider is added outside production only.
 */
import { config } from "../core/config";
import { newId } from "../core/ids";
import type { Executor } from "../db/kysely";

type Kind = "CHAT" | "IMAGE" | "TRANSCRIBE" | "SPEECH";
interface StarterModel {
  ref: string;
  name: string;
  description: string;
  kind?: Kind;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  context?: number;
  maxOut?: number;
  weight?: number;
  isDefault?: boolean;
}

const PROVIDERS: { id: string; kind: "OPENAI" | "ANTHROPIC" | "GEMINI" | "OPENAI_COMPATIBLE" | "STUB"; name: string; baseUrl: string | null; models: StarterModel[] }[] = [
  {
    id: "openai",
    kind: "OPENAI",
    name: "OpenAI",
    baseUrl: null,
    models: [
      { ref: "gpt-5.4-mini", name: "GPT-5.4 mini", description: "Fast and capable for everyday work.", vision: true, tools: true, reasoning: true, context: 400000, maxOut: 16000, weight: 1 },
      { ref: "gpt-5.4", name: "GPT-5.4", description: "OpenAI's strongest general model.", vision: true, tools: true, reasoning: true, context: 400000, maxOut: 32000, weight: 4 },
      { ref: "gpt-image-1", name: "GPT Image", description: "Image generation and editing.", kind: "IMAGE" },
      { ref: "gpt-4o-mini-transcribe", name: "Transcribe", description: "Speech to text for dictation.", kind: "TRANSCRIBE" },
      { ref: "gpt-4o-mini-tts", name: "Speech", description: "Text to speech for read aloud.", kind: "SPEECH" },
    ],
  },
  {
    id: "anthropic",
    kind: "ANTHROPIC",
    name: "Anthropic",
    baseUrl: null,
    models: [
      { ref: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", description: "Thoughtful writing, analysis and code.", vision: true, tools: true, context: 200000, maxOut: 16000, weight: 3 },
      { ref: "claude-haiku-5-5", name: "Claude Haiku 5.5", description: "Quick answers at low cost.", vision: true, tools: true, context: 200000, maxOut: 8000, weight: 0.5 },
    ],
  },
  {
    id: "gemini",
    kind: "GEMINI",
    name: "Google Gemini",
    baseUrl: null,
    models: [
      { ref: "gemini-3.5-flash", name: "Gemini 3.5 Flash", description: "Fast multimodal model with a long context.", vision: true, tools: true, context: 1000000, maxOut: 16000, weight: 0.75 },
      { ref: "gemini-3.1-flash-image", name: "Gemini Image", description: "Image generation and editing.", kind: "IMAGE" },
    ],
  },
];

const STUB = {
  id: "stub",
  kind: "STUB" as const,
  name: "Local stub",
  baseUrl: null,
  models: [
    { ref: "stub-chat", name: "Stub Pro", description: "Deterministic local model: tools, vision, streaming.", vision: true, tools: true, context: 128000, maxOut: 4096, weight: 1, isDefault: true },
    { ref: "stub-lite", name: "Stub Lite", description: "A smaller local model without tools or vision.", context: 32000, maxOut: 2048, weight: 0.25 },
    { ref: "stub-image", name: "Stub Image", description: "Draws gradient test images.", kind: "IMAGE" as const, isDefault: true },
    { ref: "stub-transcribe", name: "Stub Transcribe", description: "Fixed transcription for tests.", kind: "TRANSCRIBE" as const, isDefault: true },
    { ref: "stub-speech", name: "Stub Speech", description: "Half a second of silence.", kind: "SPEECH" as const, isDefault: true },
  ],
};

/** Insert the starter catalogue where it is missing. Returns the stub chat model ids (main, lite) when the stub was added. */
export async function ensureStarterCatalog(exec: Executor, opts: { includeStub?: boolean } = {}): Promise<{ main: string; lite: string } | null> {
  const list = opts.includeStub && config.NODE_ENV !== "production" ? [STUB, ...PROVIDERS] : PROVIDERS;
  let order = 0;
  const ids: Record<string, string> = {};
  for (const p of list) {
    await exec.insertInto("providers").values({ id: p.id, kind: p.kind, display_name: p.name, base_url: p.baseUrl, enabled: true }).onConflict((oc) => oc.column("id").doNothing()).execute();
    for (const m of p.models) {
      const kind = m.kind ?? "CHAT";
      const existing = await exec.selectFrom("models").select("id").where("provider_id", "=", p.id).where("model_ref", "=", m.ref).where("kind", "=", kind).executeTakeFirst();
      const id = existing?.id ?? newId();
      if (!existing) {
        const hasDefault = await exec.selectFrom("models").select("id").where("kind", "=", kind).where("is_default", "=", true).executeTakeFirst();
        await exec
          .insertInto("models")
          .values({
            id,
            provider_id: p.id,
            kind,
            model_ref: m.ref,
            display_name: m.name,
            description: m.description,
            supports_vision: !!("vision" in m && m.vision),
            supports_tools: !!("tools" in m && m.tools),
            supports_reasoning: !!("reasoning" in m && m.reasoning),
            context_window: ("context" in m && m.context) || 128000,
            max_output_tokens: ("maxOut" in m && m.maxOut) || 4096,
            weight: ("weight" in m && m.weight) || 1,
            enabled: true,
            is_default: !!("isDefault" in m && m.isDefault) && !hasDefault,
            sort_order: order++,
          })
          .execute();
      }
      ids[`${p.id}:${m.ref}`] = id;
    }
  }
  return ids["stub:stub-chat"] ? { main: ids["stub:stub-chat"]!, lite: ids["stub:stub-lite"]! } : null;
}
