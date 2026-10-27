# @open-chat/stubs

Deterministic stand-ins for every third party the chat talks to: OpenAI-compatible chat,
Anthropic, Gemini, image generation and edits, transcription, speech, moderation, web search,
the pages the search links to, and Firebase Cloud Messaging (push). One dependency-free Node script (`node:http`,
`node:crypto`, `node:zlib`), state in memory, port 5129.

The API runs its real provider adapters against it; only the base URL differs from
production. A production API with stub search, stub moderation or stub push refuses to boot
(`assertProductionConfig` in `apps/api/src/core/config.ts`), and the starter catalogue only
adds the stub provider outside production.

```bash
PORT=5129 node apps/stubs/server.mjs        # or: pnpm --filter @open-chat/stubs start
pnpm --filter @open-chat/stubs test          # wire-format and decision tests
```

Point the API at it:

```bash
STUBS_URL=http://localhost:5129     # providers of kind STUB call this base URL
SEARCH_PROVIDER=stub                # web_search reads GET /search
MODERATION_PROVIDER=stub            # prompts containing STUB_FLAG are flagged
PUSH_PROVIDER=stub                  # push goes to /fcm/token and /v1/projects/<p>/messages:send
```

`make dev` and the integration tests set these for you. Providers of kind OPENAI, ANTHROPIC
or GEMINI can also be pointed here by setting their base URL in Admin, Models to
`http://localhost:5129`, `http://localhost:5129/anthropic` or `http://localhost:5129/gemini`,
which is how the adapter tests exercise each wire format.

## Configuration

| Variable | Default | Used for |
| --- | --- | --- |
| `PORT` | `5129` | listen port |
| `STUB_PUBLIC_URL` | `http://localhost:$PORT` | links in search results (so `open_url` can follow them) |

Tests import `startStubs({ port: 0 })` from `server.mjs`. It returns the base `url`, a
`close()` function, the mutable `config`, and `state.requests` (the recorded calls).

## Steering the model

The stub model decides from words in the last user message, so a test can ask for exactly
the behaviour it needs:

| Words | What the model does |
| --- | --- |
| `search`, `latest`, `news`, `look up` | calls `web_search` (when the tool is offered) |
| `open https://...` | calls `open_url` with that link |
| `draw`, `image of`, `picture of` | calls `generate_image` |
| `remember` | calls `remember` with the rest of the sentence |
| `in my files`, `document`, `project` | calls `search_project_files` |
| `code` | answers with a fenced TypeScript block |
| `math`, `formula` | answers with KaTeX |
| `slow` | streams 40 sentences, 60 ms apart (resume and cancel tests) |
| `fail` | answers 500 |
| `ratelimit` | answers 429 |
| `context overflow` | answers 400 `context_length_exceeded` |

With images in the last user turn it says how many it can see. After a tool result it
answers from that result and cites `[1]`. A system prompt that asks for a title or a
summary gets a short title (the first five words of the question) or a fixed summary.

## Endpoints

| Route | Answers |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI chat, streaming (SSE) or not, with `tool_calls` and `usage` |
| `GET /v1/models` | `stub-chat`, `stub-vision`, `stub-image` |
| `POST /anthropic/v1/messages` | Anthropic Messages SSE: text and `tool_use` blocks |
| `POST /gemini/v1beta/models/<m>:streamGenerateContent`, `:generateContent` | Gemini text, function calls and inline images |
| `POST /v1/images/generations` | a real PNG gradient seeded by the prompt; `STUB_FLAG` in the prompt answers `content_policy_violation` |
| `POST /v1/images/edits` | multipart in, a PNG out |
| `POST /v1/audio/transcriptions` | multipart in, a fixed sentence out (empty for an empty file) |
| `POST /v1/audio/speech` | a short silent WAV |
| `POST /v1/moderations` | `flagged: true` when the input contains `STUB_FLAG` |
| `GET /search?q=` | results linking to `/pages/:n` on `STUB_PUBLIC_URL` |
| `GET /pages/:n` | an HTML page for `open_url` to read |
| `GET /pages/redirect-metadata` | a 302 to `169.254.169.254`, for the SSRF guard test |
| `POST /fcm/token` | the OAuth JWT bearer grant: checks `grant_type` and that the assertion names an issuer and the `firebase.messaging` scope, then answers an access token (`ya29.stub-...`, 3599 s) |
| `POST /v1/projects/<p>/messages:send` | FCM HTTP v1 send. Needs a bearer token from `/fcm/token` (else 401). Device tokens starting with `dead` answer 404 `UNREGISTERED`, starting with `bad` (or empty) 400 `INVALID_ARGUMENT`; anything else is recorded and answers `{ name }` |
| `GET /fcm/messages` | recorded FCM messages, oldest first, at most 500; `?token=` filters by device token |
| `POST /fcm/reset` | clears the recorded FCM messages |
| `GET /__/requests` | recorded requests, newest first (bodies, and whether a key was sent) |
| `POST /__/reset` | clears the record |
| `GET /up` | health check |

Keys are never checked: any `Authorization` header is accepted and recorded only as
"present" or "absent". The FCM routes are the exception: a send needs an access token the
stub itself issued, so the API's token exchange is exercised; the assertion's signature is
not verified.
