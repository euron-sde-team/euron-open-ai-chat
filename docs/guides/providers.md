# Model providers

How to connect OpenAI, Anthropic, Gemini, OpenRouter, Groq or a fully local Ollama, and how
the model catalogue works. How the adapters are built, their wire formats and the error
mapping are in [architecture/providers.md](../architecture/providers.md); the decision
behind it in [ADR 0004](../architecture/adr/0004-providers-behind-one-interface.md).

## Two halves: catalogue in the database, keys in the environment

| What | Where | Edited by |
| --- | --- | --- |
| Providers: a slug (`openai`, `groq`, `my-ollama`), a kind, a display name, an optional base URL, enabled | `providers` table | `/admin/models` (`/api/admin/providers`) |
| Models: provider, kind (`CHAT`, `IMAGE`, `TRANSCRIBE`, `SPEECH`), the provider's model id (`model_ref`), name, description, capabilities, context window, max output, weight, enabled, default, order | `models` table | `/admin/models` (`/api/admin/models`) |
| API keys, by provider slug | `PROVIDER_KEYS` (and the `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY` shortcuts) | The environment locally, the `<name_prefix>/provider-keys` secret on AWS |

A key never enters the database, a log line or an API response. The admin list shows only
`keyConfigured` per provider; the **Test** result never contains the key or the provider's
error text ([`services/admin.service.ts`](../../apps/api/src/services/admin.service.ts)).

A model is offered (in the picker, `GET /api/models`, and to turns) only when the model is
enabled, its provider is enabled, and the provider is usable: it has a key, or it is a kind
that needs none (`STUB`, `OPENAI_COMPATIBLE`). Resolution is cached 5 seconds per process
([`services/models.service.ts`](../../apps/api/src/services/models.service.ts)).

## Provider kinds

| Kind | Wire format | Default base URL | Covers |
| --- | --- | --- | --- |
| `OPENAI` | Chat Completions (`max_completion_tokens`), images, audio | `https://api.openai.com/v1` | OpenAI |
| `ANTHROPIC` | Messages API (`/v1/messages`, `x-api-key`, `anthropic-version`) | `https://api.anthropic.com` | Anthropic (chat only) |
| `GEMINI` | `streamGenerateContent` and `generateContent` (`x-goog-api-key`) | `https://generativelanguage.googleapis.com/v1beta` | Gemini chat and Gemini image models |
| `OPENAI_COMPATIBLE` | Chat Completions (`max_tokens`), images, audio | none: a base URL is required (`400 BASE_URL_REQUIRED`) | Groq, OpenRouter, Together, DeepInfra, Ollama, vLLM, LM Studio, ... |
| `STUB` | Chat Completions | `STUBS_URL` + `/v1` | The local stand-ins. Refused in production (`400 STUB_IN_PRODUCTION`) |

What each model kind needs:

| Model kind | Used for | Works with |
| --- | --- | --- |
| `CHAT` | Answers, titles, the rolling summary | Every kind |
| `IMAGE` | Image mode, the image studio, the `generate_image` tool | `OPENAI` and `OPENAI_COMPATIBLE` (`/images/generations`, `/images/edits`), `GEMINI` (image response modality). Not `ANTHROPIC` |
| `TRANSCRIBE` | Dictation | Anything that serves OpenAI's `/audio/transcriptions` (`OPENAI`, `OPENAI_COMPATIBLE`) |
| `SPEECH` | Read aloud | Anything that serves OpenAI's `/audio/speech` |

The default of each kind (one per kind, a partial unique index) is what image mode,
dictation and read aloud use, and what a turn falls back to when the requested chat model is
not usable: requested model, then the user's default model, then the deployment default,
then the first usable one.

## Model fields that change behaviour

| Field | Limits | Effect |
| --- | --- | --- |
| `modelRef` | 1 to 120 | The id sent to the provider (`gpt-5.4-mini`, `llama3.1:8b`, `anthropic/claude-sonnet-5-5` on OpenRouter) |
| `supportsVision` | boolean | Image attachments reach the model as image parts; without it, sending an image is `400 MODEL_NO_VISION` |
| `supportsTools` | boolean | The model gets native function calling (`web_search`, `open_url`, `generate_image`, `remember`, `search_project_files`). Without it the engine runs one web search before the call and gives the results as data ([chat-engine.md](../architecture/chat-engine.md)) |
| `supportsReasoning` | boolean | Sends `reasoning_effort: "low"` (Chat Completions); reasoning text the provider streams is sent as `reasoning.delta` events and kept on the message |
| `contextWindow` | 1024 to 10,000,000 | The context budget: `contextWindow - maxOutputTokens - 1500` |
| `maxOutputTokens` | 16 to 1,000,000 | Sent as the output limit |
| `weight` | 0.01 to 1000 | Multiplies tokens against the daily allowance (a large model can count 4, a small one 0.25) ([quotas.md](../architecture/quotas.md)) |
| `isDefault`, `sortOrder`, `enabled` | | Picker order and defaults |

Setting a capability the model does not have makes the provider refuse the call; the user
sees `PROVIDER_ERROR` and the log has a masked excerpt of the provider's answer.

## Starting from an empty catalogue

`make demo` runs `ensureStarterCatalog` ([`demo/catalog.ts`](../../apps/api/src/demo/catalog.ts)),
which adds providers `openai`, `anthropic` and `gemini` with a few current models (and the
stub outside production). Nothing calls it on a production install: a new AWS deployment
starts with **no providers and no models**, and chats answer `503 MODEL_UNAVAILABLE` until
an admin creates them. The steps below are the same either way.

## Admin steps (`/admin/models`)

1. **Put the key in the environment** under the slug you will use (next section). Restart
   the API and worker so they read it.
2. **Create the provider**: slug (`^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`, it is also the key
   name in `PROVIDER_KEYS`), kind, display name, base URL (empty for the kinds with a
   default; http or https only).
3. **Add models**: kind, `modelRef`, display name, description, capabilities, context window,
   max output, weight; mark one CHAT model as default.
4. **Test**: `POST /api/admin/models/:id/test` makes one tiny call ("Reply with the single
   word: ok", 16 tokens) and answers `{ ok, latencyMs, message }`: "The provider rejected the
   key.", "check the model id", "did not answer in time", and so on. Only chat models are
   called; for the other kinds it checks that an endpoint and key exist.

Every create, update and delete is in the audit trail.

## Keys

`PROVIDER_KEYS` is one JSON object keyed by provider slug; the shortcuts fill the slugs of
the same name, and `PROVIDER_KEYS` wins when both name one. Empty values and `set-me` are
ignored.

```bash
# deploy/compose/.env (local), placeholders shown
PROVIDER_KEYS={"openai":"<openai-key>","anthropic":"<anthropic-key>","gemini":"<gemini-key>","openrouter":"<openrouter-key>","groq":"<groq-key>"}
```

On AWS, put the whole object into the secret and roll the services
([deploy-aws.md](deploy-aws.md#provider-and-search-keys)):

```bash
aws secretsmanager put-secret-value --secret-id <name_prefix>/provider-keys \
  --secret-string '{"openai":"<openai-key>","anthropic":"<anthropic-key>"}'
```

## OpenAI

| Provider | Slug `openai`, kind `OPENAI`, base URL empty |
| --- | --- |
| Key | `{"openai":"<openai-key>"}` or `OPENAI_API_KEY` |
| Models | CHAT models with vision, tools and reasoning; an IMAGE model (`gpt-image-1` in the starter catalogue); TRANSCRIBE and SPEECH models for voice |

The same key also serves `MODERATION_PROVIDER=openai`.

## Anthropic

| Provider | Slug `anthropic`, kind `ANTHROPIC`, base URL empty |
| --- | --- |
| Key | `{"anthropic":"<anthropic-key>"}` or `ANTHROPIC_API_KEY` |
| Models | CHAT models with vision and tools. For images and voice, add an OpenAI, Gemini or compatible provider next to it |

The adapter speaks the native Messages API: the system prompt is a top-level field, tool
results go back as `tool_result` blocks, and streamed `thinking_delta` text becomes
reasoning ([`integrations/llm/anthropic.ts`](../../apps/api/src/integrations/llm/anthropic.ts)).

## Google Gemini

| Provider | Slug `gemini`, kind `GEMINI`, base URL empty |
| --- | --- |
| Key | `{"gemini":"<gemini-key>"}` or `GEMINI_API_KEY` |
| Models | CHAT models with vision and tools (long context windows); an IMAGE model for generation and editing |

## OpenRouter

One key, hundreds of models from many vendors, all over the Chat Completions format.

| Provider | Slug `openrouter`, kind `OPENAI_COMPATIBLE`, base URL `https://openrouter.ai/api/v1` |
| --- | --- |
| Key | `{"openrouter":"<openrouter-key>"}` or `OPENROUTER_API_KEY` |
| Models | `modelRef` is OpenRouter's id, `vendor/model`. Set vision and tools to what that model supports |

OpenRouter streams reasoning as `delta.reasoning`, which the adapter reads.

## Groq

| Provider | Slug `groq`, kind `OPENAI_COMPATIBLE`, base URL `https://api.groq.com/openai/v1` |
| --- | --- |
| Key | `{"groq":"<groq-key>"}` or `GROQ_API_KEY` |
| Models | Fast open-weight CHAT models (check which support tool calling); Groq's Whisper models work as a TRANSCRIBE model through `/audio/transcriptions` |

## Ollama: fully local

Run models on your own machine or server; no key and nothing leaves your network.

1. Run Ollama and pull a model: `ollama pull llama3.1:8b` (a vision model such as `llava`
   if you want images).
2. Create the provider: slug `ollama`, kind `OPENAI_COMPATIBLE`, base URL
   `http://host.docker.internal:11434/v1` when the API runs in Docker Desktop and Ollama on
   the host (on Linux use the host's address on the Docker bridge, or run Ollama as a
   compose service and use its service name). No key: `OPENAI_COMPATIBLE` providers are
   usable without one.
3. Add a CHAT model with `modelRef` `llama3.1:8b`, a context window that matches how you run
   it, `supportsTools` only if the model handles tool calls well, and a low weight.
4. Test it, make it the default, and optionally disable the hosted providers.

vLLM and LM Studio work the same way with their own base URLs. Local servers often report no
token usage; the engine then estimates tokens (about 4 characters each) so the daily
allowance still moves.

For a fully local deployment also pick `SEARCH_PROVIDER=searxng` (self-hosted) or `none`
and leave `MODERATION_PROVIDER=none` ([web-search.md](web-search.md)).

## The stub provider

`make demo` adds the **Local stub** provider (slug `stub`, kind `STUB`) with deterministic
models served by [`apps/stubs/server.mjs`](../../apps/stubs/server.mjs). It is how the
local stack and the test suites run without keys; its trigger words are listed in
[testing.md](testing.md#the-stubs). The API refuses to create a `STUB` provider with
`NODE_ENV=production`, and `ensureStarterCatalog` never adds it there.

## When something fails

Provider failures are classified once ([`integrations/http.ts`](../../apps/api/src/integrations/http.ts))
and reach the user as a stable code with a fixed message, never provider text:

| Provider answer | Turn error code |
| --- | --- |
| 401 or 403 | `MODEL_UNAVAILABLE` |
| 429 | `PROVIDER_RATE_LIMITED` |
| 400/413/422 mentioning the context length | `CONTEXT_TOO_LONG` |
| 400/413/422 mentioning a content policy or safety | `CONTENT_BLOCKED` |
| anything else, a timeout (180 s per call), unreachable | `PROVIDER_ERROR` |

The operator finds the cause in the API log: `provider call failed` with the provider slug,
the status and a 600-character excerpt with anything key-shaped masked. More in
[troubleshooting.md](troubleshooting.md#models-and-providers).
