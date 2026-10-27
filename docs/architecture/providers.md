# Model providers

How the chat talks to model providers: one internal interface, three wire formats, one
SSE reader, one failure classification, and keys that never leave the server's
environment. The decision is [ADR 0004](adr/0004-providers-behind-one-interface.md);
step-by-step setup for each provider is in [guides/providers.md](../guides/providers.md).
Paths are relative to the repository root.

## 1. The shape every adapter speaks

[`apps/api/src/integrations/llm/types.ts`](../../apps/api/src/integrations/llm/types.ts):

```ts
interface LlmAdapter {
  stream(req: LlmRequest, endpoint: Endpoint): AsyncGenerator<LlmEvent>;
}

type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: LlmPart[] }            // text and base64 image parts
  | { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

type LlmEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: { id: string; name: string; arguments: string } }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "finish"; reason: "stop" | "length" | "tool_calls" | "content_filter" | "other" };

interface Endpoint { provider: string; baseUrl: string; apiKey: string | null }
```

Nothing above this layer knows which provider answered: the engine, titles, summaries and
the admin test call all use `adapter.stream()`. Tool call arguments are passed through as
the model's JSON text; the tool validates them (`parseArgs` tolerates empty or invalid
JSON).

## 2. Provider kinds and adapters

[`apps/api/src/integrations/llm/index.ts`](../../apps/api/src/integrations/llm/index.ts):

| `provider_kind` | Adapter | Default base URL | Auth header |
| --- | --- | --- | --- |
| `OPENAI` | `openAiChat({ maxTokensField: "max_completion_tokens" })` | `https://api.openai.com/v1` | `Authorization: Bearer <key>` |
| `OPENAI_COMPATIBLE` | `openAiChat({ maxTokensField: "max_tokens" })` | none: the admin must set `base_url` | Bearer when a key is configured, none otherwise |
| `ANTHROPIC` | `anthropic` | `https://api.anthropic.com` | `x-api-key`, `anthropic-version: 2023-06-01` |
| `GEMINI` | `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `x-goog-api-key` |
| `STUB` | `openAiChat({ maxTokensField: "max_tokens" })` | `${STUBS_URL}/v1` | none |

`OPENAI_COMPATIBLE` covers Groq, OpenRouter, Together, DeepInfra, Ollama, vLLM, LM Studio
and anything else that implements `POST /chat/completions` with streaming.

### 2.1 Chat Completions ([`openai-chat.ts`](../../apps/api/src/integrations/llm/openai-chat.ts))

- Request: `model`, `messages`, `stream: true`, `stream_options.include_usage`, the max
  tokens field, `temperature` when set, `tools` as `{ type: "function", function }`,
  `reasoning_effort` for reasoning models.
- Images are `image_url` parts with a `data:` URL; tool results are `role: "tool"` with
  `tool_call_id`; an assistant turn with tool calls carries `tool_calls`.
- Stream: `delta.content` is text; `delta.reasoning_content` (DeepSeek, Qwen on vLLM) or
  `delta.reasoning` (OpenRouter) is reasoning; tool call fragments are keyed by `index`
  and assembled, then emitted whole when the stream ends; a final chunk with `usage`
  gives token counts (servers that ignore `include_usage` report none and the engine
  estimates); `[DONE]` ends it.

### 2.2 Anthropic Messages ([`anthropic.ts`](../../apps/api/src/integrations/llm/anthropic.ts))

- `POST /v1/messages`, native (not an OpenAI shim). System messages are joined into the
  top-level `system` field; images are base64 `image` blocks; tools are
  `{ name, description, input_schema }`.
- Tool calls go back as `tool_use` blocks in the assistant turn and results as
  `tool_result` blocks in a user turn; consecutive same-role turns are merged, as the API
  requires.
- Stream events: `message_start` (input tokens), `content_block_start` (a `tool_use`
  begins), `content_block_delta` (`text_delta`, `thinking_delta`, `input_json_delta`),
  `message_delta` (stop reason, output tokens). `refusal` maps to `content_filter`. An
  `error` event in the stream ends the turn as `INTERNAL`.
- `reasoningEffort` is not sent; thinking deltas are forwarded when the model streams them.

### 2.3 Gemini ([`gemini.ts`](../../apps/api/src/integrations/llm/gemini.ts))

- `POST /models/<model>:streamGenerateContent?alt=sse`. System messages become
  `systemInstruction`; images are `inlineData`; tools are `functionDeclarations`, with
  JSON Schema keywords Gemini refuses removed at every depth (`additionalProperties`,
  `$schema`, `default`, `examples`, `$id`, `$ref`).
- A model's call is a `functionCall` part (an id is made up when Gemini sends none) and the
  result goes back as a `functionResponse` part in a user turn.
- Parts with `thought: true` are reasoning. `SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST`,
  `SPII`, `RECITATION` and a prompt `blockReason` map to `content_filter`. Output tokens
  include thought tokens.

### 2.4 Images and speech

- Images ([`integrations/images/index.ts`](../../apps/api/src/integrations/images/index.ts)):
  the OpenAI images API (`/images/generations`, `/images/edits` multipart, base64 out) for
  `OPENAI`, `OPENAI_COMPATIBLE` and `STUB`; Gemini `generateContent` with
  `responseModalities: ["IMAGE", "TEXT"]` and `imageConfig.aspectRatio`. Aspect ratios map
  to the three gpt-image sizes. Anthropic has no image output (`BAD_REQUEST`).
- Speech ([`integrations/speech/index.ts`](../../apps/api/src/integrations/speech/index.ts)):
  `POST /audio/transcriptions` (multipart) and `POST /audio/speech` (MP3, streamed
  through). Any OpenAI-compatible server that implements them works.

## 3. One SSE reader, plain fetch

There is no vendor SDK. [`integrations/http.ts`](../../apps/api/src/integrations/http.ts)
gives every adapter:

- `providerFetch(provider, url, init)`: `fetch` that maps network failures and timeouts to
  `ProviderError` and non-2xx responses through `failFromResponse`. A caller's abort (the
  user pressed stop) is passed through as an `AbortError`, not a provider failure.
- `withTimeout(signal, ms)`: the caller's signal combined with a deadline (180 s for chat,
  images and speech; 15 s for search; 10 s for moderation).
- `readSse(body)`: a text/event-stream parser that handles events split across chunks,
  CRLF line endings, multi-line `data:` fields and comments.

The result is a few hundred lines that are easy to read, test against the stubs, and patch
when a provider changes a field, with no transitive dependencies that hold keys.

## 4. Failure classification

`failFromResponse` reads the body, logs at most 600 characters of it with anything
key-shaped masked (`maskSecrets`: `sk-`, `rk-`, `pk-`, `AIza...`, bearer tokens), and
throws a `ProviderError` with one of these classes. The body never goes further.

| Provider answer | `ProviderFailure` | Turn error code | Admin test message |
| --- | --- | --- | --- |
| 401, 403 | `AUTH` | `MODEL_UNAVAILABLE` | "The provider rejected the key." |
| 429 | `RATE_LIMITED` | `PROVIDER_RATE_LIMITED` | "The provider is rate limiting this key." |
| 400, 413, 422 mentioning context length | `CONTEXT_TOO_LONG` | `CONTEXT_TOO_LONG` | "The provider refused the request." |
| 400, 413, 422 mentioning content policy, safety, moderation | `CONTENT_FILTER` | `CONTENT_BLOCKED` | "The provider refused the request." |
| Other 400, 413, 422 | `BAD_REQUEST` | `PROVIDER_ERROR` | "The provider refused the request: check the model id." |
| 5xx, other status, unreachable | `UNAVAILABLE` | `PROVIDER_ERROR` | "The provider could not be reached or had an error." |
| Deadline passed | `TIMEOUT` | `PROVIDER_ERROR` | "The provider did not answer in time." |

Users see the fixed message for the turn error code ([chat-engine.md](chat-engine.md));
admins see the fixed test message. In the system this was ported from, raw provider error
text was passed to users, which leaked model names, quota details and sometimes request
ids of the operator's account.

## 5. Keys

- **Where they live.** `PROVIDER_KEYS`, a JSON object keyed by provider slug
  (`{"openai":"<key>","anthropic":"<key>","openrouter":"<key>"}`), plus the shortcuts
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` and
  `GROQ_API_KEY` for the providers with those slugs. `PROVIDER_KEYS` wins when both name
  one. On AWS the whole `<prefix>/provider-keys` secret is injected as `PROVIDER_KEYS`
  ([`apps/api/src/core/config.ts`](../../apps/api/src/core/config.ts) `providerKeys`).
- **Placeholders.** Empty values and `set-me` (the Terraform placeholder) count as not
  configured. A malformed `PROVIDER_KEYS` is ignored with nothing echoed (it holds
  secrets).
- **Per call.** `endpointFor(provider)` looks the key up by slug every time a model is
  resolved ([`apps/api/src/services/models.service.ts`](../../apps/api/src/services/models.service.ts)).
  It is never part of a row, a DTO, a log line or an error.
- **What admins see.** `GET /api/admin/providers` returns `keyConfigured: true|false`.
  There is no endpoint that accepts or returns a key. Rotating one is a secret update and a
  service restart.
- **Proof.** The integration suite sets `OPENAI_API_KEY` to a canary and asserts no
  response it fetches ever contains it
  ([`apps/api/test/integration/secrets.int.test.ts`](../../apps/api/test/integration/secrets.int.test.ts)).

In the system this was ported from, provider keys were stored in plaintext in the
database; anyone with a dump or a lax admin endpoint had them.

## 6. The catalogue

`providers` and `models` ([data-model.md](data-model.md#the-model-catalogue)) are the one
source of truth, edited in `/admin/models`. A model is offered when it is enabled, its
provider is enabled and the provider is usable (a key, or a kind that needs none). The
catalogue is cached per process for 5 s.

| Model field | Effect |
| --- | --- |
| `kind` | `CHAT` models answer; the default `IMAGE`, `TRANSCRIBE` and `SPEECH` models back images, dictation and read aloud |
| `model_ref` | Sent as the provider's model id |
| `supports_vision` | Images are sent as pixels; without it, sending an image is `400 MODEL_NO_VISION` |
| `supports_tools` | Tools are offered; without it, web search becomes one pre-search ([chat-engine.md](chat-engine.md#3-the-tool-loop)) |
| `supports_reasoning` | `reasoning_effort: "low"` is sent (Chat Completions) |
| `context_window`, `max_output_tokens` | The context budget and the max tokens field |
| `weight` | Multiplies tokens against the daily allowance ([quotas.md](quotas.md)) |
| `is_default`, `sort_order`, `enabled` | Picker order and fallback |

A fresh production install has an empty catalogue: the starter list in
[`apps/api/src/demo/catalog.ts`](../../apps/api/src/demo/catalog.ts) is inserted only by
`demo:seed` (with the stub provider outside production). On AWS the first admin creates
providers and models in `/admin/models`.

## 7. Adding a provider or a model

**A new model of a supported kind** is data: add it in `/admin/models` (provider, model
id, kind, capabilities, context window, max output, weight) and press Test, which makes one
16-token call and reports a fixed message.

**A new OpenAI-compatible service** is data too: a provider of kind `OPENAI_COMPATIBLE`
with its base URL (ending in `/v1` for most servers) and a slug; put the key under that
slug in `PROVIDER_KEYS`.

**A new wire format** is code:

1. Add the kind to `provider_kind` in a new migration and to `ProviderKind` in
   [`packages/types`](../../packages/types/src/index.ts).
2. Write `integrations/llm/<name>.ts` implementing `LlmAdapter`: map `LlmMessage[]` and
   `LlmTool[]` to the wire, use `providerFetch`, `withTimeout` and `readSse`, emit `text`,
   `reasoning`, whole `tool_call`s, one `usage` and one `finish`.
3. Register it in `ADAPTERS` and give it a `defaultBaseUrl`.
4. Add the provider's speaking part to [`apps/stubs/server.mjs`](../../apps/stubs/server.mjs)
   so the integration suite can drive it, and unit tests for the wire mapping next to
   [`apps/api/test/unit/llm-adapters.test.ts`](../../apps/api/test/unit/llm-adapters.test.ts).
5. If it has image or speech endpoints in another shape, extend
   `integrations/images` or `integrations/speech`.
6. Make sure every non-2xx path goes through `failFromResponse`.
