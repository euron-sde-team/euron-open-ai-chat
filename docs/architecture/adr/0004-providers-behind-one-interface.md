# ADR 0004: Providers behind one interface, keys never in the database

## Status

Accepted.

## Context

Operators want to choose their models: OpenAI, Anthropic, Gemini, an aggregator such as
OpenRouter, a fast host such as Groq, or a model running on their own hardware (Ollama,
vLLM, LM Studio). Model ids change every few months. The system this was ported from
stored provider keys in plaintext in its database, used a different SDK per vendor with
its own streaming and error shapes, and passed raw provider error text to users, which
leaked model names, quota details and request ids of the operator's account.

## Decision

- One shape for every chat model: `LlmAdapter.stream(req, endpoint)` yields `LlmEvent`s
  (`text`, `reasoning`, `tool_call`, `usage`, `finish`)
  ([`integrations/llm/types.ts`](../../../apps/api/src/integrations/llm/types.ts)). Three
  wire formats implement it: Chat Completions for `OPENAI`, `OPENAI_COMPATIBLE` and `STUB`
  ([`openai-chat.ts`](../../../apps/api/src/integrations/llm/openai-chat.ts)), Anthropic
  Messages ([`anthropic.ts`](../../../apps/api/src/integrations/llm/anthropic.ts)) and
  Gemini `streamGenerateContent`
  ([`gemini.ts`](../../../apps/api/src/integrations/llm/gemini.ts)), chosen by
  `provider_kind` in [`integrations/llm/index.ts`](../../../apps/api/src/integrations/llm/index.ts).
- No vendor SDKs: adapters use plain `fetch` and one Server-Sent Events reader, `readSse`,
  shared by all of them ([`integrations/http.ts`](../../../apps/api/src/integrations/http.ts)).
- The catalogue is data: `providers` (slug, kind, base URL) and `models` (kind `CHAT`,
  `IMAGE`, `TRANSCRIBE`, `SPEECH`, capabilities, context window, weight), edited in
  `/admin` and read through
  [`services/models.service.ts`](../../../apps/api/src/services/models.service.ts).
- Keys are configuration only: `PROVIDER_KEYS` (a JSON object by provider slug, from
  Secrets Manager on AWS) plus shortcuts such as `OPENAI_API_KEY`
  ([`core/config.ts`](../../../apps/api/src/core/config.ts) `providerKeys`). A key is looked
  up per resolution and is never a column, a DTO field or a log value; the admin API
  reports only `keyConfigured`. A provider without a key (other than `STUB` and
  `OPENAI_COMPATIBLE`) is simply not offered.
- Failures map to one classification, `ProviderError` with `AUTH`, `RATE_LIMITED`,
  `CONTEXT_TOO_LONG`, `BAD_REQUEST`, `CONTENT_FILTER`, `UNAVAILABLE` or `TIMEOUT`. The body
  is logged truncated with key-shaped strings masked (`maskSecrets`); users see a stable
  `TurnErrorCode` and a fixed message ([`services/chat/turns.ts`](../../../apps/api/src/services/chat/turns.ts)).

## Consequences

Positive:

- Adding an OpenAI-compatible host is a row in `providers`, not code. Adding a new wire
  format is one adapter file ([providers.md](../providers.md)).
- Keys cannot leak through a database dump, a backup, an export or an admin screen; the
  integration suite checks no response contains a canary key.
- Tool calls, vision parts, reasoning and usage look the same to the turn engine whoever
  answers.

Trade-offs:

- Each wire format's streaming quirks are ours to maintain (tool argument fragments,
  Gemini calls without ids, Anthropic's merged tool results).
- New vendor features arrive when an adapter learns them, not with an SDK upgrade.
- Changing a key means updating the secret and restarting the tasks; there is no key form
  in the UI.

## Alternatives considered

- **Vendor SDKs.** Three dependency trees, three error models and three streaming APIs to
  normalise anyway.
- **Keys encrypted in the database.** Still readable by anyone with the application role
  and the encryption key, and invites a key form that echoes values back.
- **An external gateway (a proxy in front of all providers).** One more service to run for
  something a small adapter layer does.
