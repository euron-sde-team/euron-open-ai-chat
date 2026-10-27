/**
 * Image generation and editing. Two wire formats:
 *   openai  POST /images/generations (and /images/edits, multipart) returning base64;
 *           OpenAI's gpt-image models, OpenAI-compatible servers and the stub.
 *   gemini  generateContent with an IMAGE response modality; an edit sends the source
 *           image as an inlineData part next to the instruction.
 * Output is always raw bytes plus a mime type; storage and the gallery are the caller's.
 */
import type { AspectRatio, ProviderKind } from "@open-chat/types";
import { ProviderError, providerFetch, withTimeout } from "../http";
import type { Endpoint } from "../llm/types";

export interface ImageRequest {
  model: string;
  prompt: string;
  aspectRatio: AspectRatio;
  /** Edit this image instead of drawing from nothing. */
  source?: { data: Buffer; mimeType: string };
  signal?: AbortSignal;
}

export interface ImageResult {
  data: Buffer;
  mimeType: string;
  /** What the model said it drew, when it says anything (Gemini sometimes adds text). */
  note: string | null;
}

/** gpt-image sizes for each ratio (the API accepts these three; 4:3 and 3:4 map to the nearest). */
const OPENAI_SIZES: Record<AspectRatio, string> = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "4:3": "1536x1024",
  "9:16": "1024x1536",
  "3:4": "1024x1536",
};

async function openAiImage(req: ImageRequest, endpoint: Endpoint): Promise<ImageResult> {
  const base = endpoint.baseUrl.replace(/\/$/, "");
  const auth: Record<string, string> = endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {};
  let res: Response;
  if (req.source) {
    const form = new FormData();
    form.set("model", req.model);
    form.set("prompt", req.prompt);
    form.set("size", OPENAI_SIZES[req.aspectRatio]);
    form.set("image", new Blob([new Uint8Array(req.source.data)], { type: req.source.mimeType }), `source.${req.source.mimeType.split("/")[1] ?? "png"}`);
    res = await providerFetch(endpoint.provider, `${base}/images/edits`, { method: "POST", headers: auth, body: form, signal: withTimeout(req.signal, 180_000) });
  } else {
    res = await providerFetch(endpoint.provider, `${base}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ model: req.model, prompt: req.prompt, size: OPENAI_SIZES[req.aspectRatio], n: 1 }),
      signal: withTimeout(req.signal, 180_000),
    });
  }
  const json = (await res.json()) as { data?: { b64_json?: string; revised_prompt?: string }[]; output_format?: string };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new ProviderError("UNAVAILABLE", endpoint.provider);
  const fmt = json.output_format ?? "png";
  return { data: Buffer.from(b64, "base64"), mimeType: fmt === "jpeg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png", note: json.data?.[0]?.revised_prompt ?? null };
}

async function geminiImage(req: ImageRequest, endpoint: Endpoint): Promise<ImageResult> {
  const parts: Record<string, unknown>[] = [{ text: req.prompt }];
  if (req.source) parts.push({ inlineData: { mimeType: req.source.mimeType, data: req.source.data.toString("base64") } });
  const res = await providerFetch(endpoint.provider, `${endpoint.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(req.model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(endpoint.apiKey ? { "x-goog-api-key": endpoint.apiKey } : {}) },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: req.aspectRatio } } }),
    signal: withTimeout(req.signal, 180_000),
  });
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; inlineData?: { mimeType: string; data: string } }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
  if (json.promptFeedback?.blockReason) throw new ProviderError("CONTENT_FILTER", endpoint.provider);
  const out = json.candidates?.[0]?.content?.parts ?? [];
  const img = out.find((p) => p.inlineData)?.inlineData;
  if (!img) throw new ProviderError(json.candidates?.[0]?.finishReason === "SAFETY" ? "CONTENT_FILTER" : "UNAVAILABLE", endpoint.provider);
  return { data: Buffer.from(img.data, "base64"), mimeType: img.mimeType, note: out.find((p) => p.text)?.text ?? null };
}

export function generateImage(kind: ProviderKind, req: ImageRequest, endpoint: Endpoint): Promise<ImageResult> {
  if (kind === "GEMINI") return geminiImage(req, endpoint);
  if (kind === "ANTHROPIC") throw new ProviderError("BAD_REQUEST", endpoint.provider);
  return openAiImage(req, endpoint);
}
