/**
 * Dictation and read aloud through the OpenAI audio endpoints, which OpenAI-compatible
 * servers (and the stub) also implement:
 *   POST /audio/transcriptions  multipart audio -> { text }
 *   POST /audio/speech          { model, input, voice } -> audio bytes (streamed through)
 * Audio is never stored: dictation reads the upload from memory, speech streams to the client.
 */
import { providerFetch, withTimeout } from "../http";
import type { Endpoint } from "../llm/types";

export async function transcribe(model: string, audio: { data: Buffer; mimeType: string; fileName: string }, endpoint: Endpoint, language?: string): Promise<string> {
  const form = new FormData();
  form.set("model", model);
  form.set("file", new Blob([new Uint8Array(audio.data)], { type: audio.mimeType }), audio.fileName);
  if (language) form.set("language", language);
  const res = await providerFetch(endpoint.provider, `${endpoint.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {},
    body: form,
    signal: withTimeout(undefined, 120_000),
  });
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

export const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] as const;

export async function speak(model: string, text: string, voice: string, endpoint: Endpoint, signal?: AbortSignal): Promise<Response> {
  return providerFetch(endpoint.provider, `${endpoint.baseUrl.replace(/\/$/, "")}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}) },
    body: JSON.stringify({ model, input: text, voice, response_format: "mp3" }),
    signal: withTimeout(signal, 120_000),
  });
}
