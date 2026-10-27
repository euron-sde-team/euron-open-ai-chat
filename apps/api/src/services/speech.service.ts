/**
 * Dictation (speech to text into the composer) and read aloud (text to speech of an
 * answer), through the deployment's TRANSCRIBE and SPEECH models. Audio is never stored.
 * Both count against the daily token allowance, as estimated tokens times the model weight.
 */
import type { Response } from "express";
import { Readable } from "node:stream";
import { type Actor, requireActive } from "../core/context";
import { badRequest, forbidden, HttpError, notFound } from "../core/errors";
import { estimateTokens } from "../domain/chunking";
import { normaliseMime, sniffMatches } from "../domain/file-rules";
import { speak, transcribe } from "../integrations/speech";
import { consume } from "../middleware/rate-limit";
import { chatRepo } from "../repositories/chat.repository";
import { resolveKind } from "./models.service";
import { preferencesOf } from "./preferences.service";
import { assertTokensLeft, QuotaExceededError, recordUsage, weighted } from "./quota.service";
import { getSettings } from "./settings.service";

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav"]);
const TTS_MAX_CHARS = 4000;

async function allowance(userId: string): Promise<void> {
  try {
    await assertTokensLeft(userId);
  } catch (err) {
    if (err instanceof QuotaExceededError) throw new HttpError(429, err.message, "QUOTA_EXCEEDED");
    throw err;
  }
}

export async function dictate(actor: Actor, audio: { data: Buffer; mimeType: string }, language?: string): Promise<{ text: string }> {
  requireActive(actor);
  if (!(await getSettings()).features.dictation) throw forbidden("Dictation is turned off", "DICTATION_DISABLED");
  await consume("dictation", `u:${actor.id}`, 20, 60);
  const mime = normaliseMime(audio.mimeType);
  if (!AUDIO_TYPES.has(mime)) throw badRequest("Unsupported audio format", "AUDIO_TYPE_NOT_ALLOWED");
  if (!audio.data.length) throw badRequest("No audio received", "AUDIO_EMPTY");
  // The bytes must be the audio they claim to be (the same magic-number check as uploads).
  if (!sniffMatches(mime, audio.data.subarray(0, 4096))) throw badRequest("The audio does not match its type", "AUDIO_TYPE_MISMATCH");
  const model = await resolveKind("TRANSCRIBE");
  if (!model) throw new HttpError(503, "Dictation is not available", "MODEL_UNAVAILABLE");
  await allowance(actor.id);
  const ext = mime.split("/")[1]?.replace("x-", "").replace("mpeg", "mp3") ?? "webm";
  const text = await transcribe(model.model.model_ref, { data: audio.data, mimeType: mime, fileName: `dictation.${ext}` }, model.endpoint, language);
  // Roughly a token per second of speech; billed by what came out.
  await recordUsage({ userId: actor.id, modelId: model.model.id, outputTokens: estimateTokens(text), weightedTokens: weighted(0, estimateTokens(text) + 50, Number(model.model.weight)) });
  return { text };
}

/** Stream an answer as MP3. `messageId` is one of your assistant messages. */
export async function readAloud(actor: Actor, messageId: string, res: Response, signal: AbortSignal): Promise<void> {
  requireActive(actor);
  if (!(await getSettings()).features.readAloud) throw forbidden("Read aloud is turned off", "READ_ALOUD_DISABLED");
  await consume("tts", `u:${actor.id}`, 30, 60);
  const m = await chatRepo.findOwnedMessage(actor.id, messageId);
  if (!m || m.role !== "ASSISTANT") throw notFound("Message not found", "MESSAGE_NOT_FOUND");
  if (!m.content.trim()) throw badRequest("Nothing to read", "MESSAGE_EMPTY");
  const model = await resolveKind("SPEECH");
  if (!model) throw new HttpError(503, "Read aloud is not available", "MODEL_UNAVAILABLE");
  await allowance(actor.id);
  const text = speakable(m.content).slice(0, TTS_MAX_CHARS);
  const { voice } = await preferencesOf(actor.id);
  const upstream = await speak(model.model.model_ref, text, voice, model.endpoint, signal);
  await recordUsage({ userId: actor.id, modelId: model.model.id, inputTokens: estimateTokens(text), weightedTokens: weighted(estimateTokens(text), 0, Number(model.model.weight)) });
  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  if (!upstream.body) return void res.end();
  Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
}

/** Markdown to something worth hearing: no code blocks, links read as their text, no symbols. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[(\d+)\]/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, " (formula) ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
