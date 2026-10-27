# Low-level design

How the API is organised: the layers and the conventions every module follows, auth and
sessions, the modules one by one, background jobs, rate limits and errors. The system view
is in [HLD.md](HLD.md); tables are in [data-model.md](data-model.md); the turn engine has
its own page, [chat-engine.md](chat-engine.md). Paths are relative to the repository root;
`api/` below means `apps/api/src/`.

## 1. Layout

```
apps/api/src/
  index.ts            HTTP entry: config guard, optional migrate, register jobs, listen, drain
  worker.ts           BullMQ entry: one Worker per queue, the repeatable schedules
  cli.ts              admin:create, demo:seed
  app.ts              createApp(): request id, logging, helmet, CORS, JSON, health, routes, errors
  core/               config, context (Actor, requireActive, requireAdmin), effects, errors,
                      ids, cursor, validate, logger, aws client config, data-dir
  db/                 kysely.ts (pool, types init), connection-config.ts, types.ts (generated)
  domain/             pure rules: chunking, file-rules, net-guard, display-name, username
  routes/             one file per mount; index.ts is the MOUNTS table
  controllers/        zod parse, call one service, send (auth, chat, file, me, user, admin)
  services/           business rules, transactions, effects
    chat/             chat.service (conversations, sends, branches), turns (the engine),
                      context, prompt, tools, event-log, titles, summary
  repositories/       Kysely queries for users, sessions, tokens, chats, files, audit; keyset.ts
  presenters/         rows to DTOs from @open-chat/types (chat, file, user), batched
  integrations/       llm/ (openai-chat, anthropic, gemini), images, speech, search,
                      moderation, extract, fetch-page, http (fetch + SSE + failure mapping),
                      storage (s3 | local), mail, redis
  jobs/               registry.ts, chat.jobs.ts, maintenance.jobs.ts
  security/           passwords (bcrypt), tokens (JWT, refresh), totp
  middleware/         auth, rate-limit, sse, http helpers
  demo/               catalog.ts (starter providers and models), seed.ts, content.ts
apps/web/src/         Next.js app router: (chat), (auth), (admin), share/[id]; components; lib
packages/types        DTOs, enums and the TurnEvent catalogue shared by every client
packages/api-client   typed client: refresh, endpoints, uploads, the resumable turn reader
packages/ui           components and tokens
apps/stubs            deterministic stand-ins for every third party (local and tests)
db/                   migrate.ts and migrations/0001_init.sql
```

## 2. Layers and conventions

The layering is [ADR 0003](adr/0003-layering.md):

| Layer | Does | Never does |
| --- | --- | --- |
| Route (`routes/*.routes.ts`) | Declares `router.<method>(path, ...guards, ctrl.fn)` with a doc comment; guards are `authenticate` and `rateLimit(name, points, seconds, by)` | Business logic. [`scripts/gen-openapi.ts`](../../scripts/gen-openapi.ts) reads these files, so one statement per route |
| Controller (`controllers/`) | `parse(schema, req.body / query / params)` with strict zod schemas, `actorOf(req)`, one service call, the status code; for turns, opening the SSE response | Reads the database |
| Service (`services/`) | Takes an `Actor` (never a request), applies rules, scopes every query to the actor, opens transactions, queues effects, writes audit rows | Trusts an id from the client without an ownership check |
| Domain (`domain/`) | Pure functions over plain values: file type rules and sniffers, chunking and token estimates, the address and URL guards | I/O of any kind |
| Repository (`repositories/`) | Kysely queries, recursive CTEs for the message tree, conditional updates; accepts `exec: Executor = db` so callers pass a transaction | Decides access |
| Presenter (`presenters/`) | Rows to DTOs field by field, batching related lookups (files, model names, sibling ids, signed URLs) | Spreads a row into a DTO (a new column, such as `storage_key`, must never leak by accident) |
| Integration (`integrations/`) | One outside system each, behind a small function or interface; maps failures to stable codes | Returns a provider's error text to a caller |

The chat services and a few others read small tables inline with `db` where no repository
method exists (projects, memories, images); the scoping rule still applies to every one.

Conventions that hold everywhere:

- **Identity comes from the token.** No body field names the acting user. A service gets
  `Actor { id, username, displayName, role, status }` from
  [`middleware/auth.ts`](../../apps/api/src/middleware/auth.ts).
- **Writes need an ACTIVE account.** `requireActive(actor)` refuses SUSPENDED accounts with
  `403 ACCOUNT_RESTRICTED`; a suspended user can still read their chats
  ([`core/context.ts`](../../apps/api/src/core/context.ts)).
- **Strict input.** Body schemas are `.strict()`: an unknown key is `400 VALIDATION_FAILED`
  with `details.fields`. A client cannot send `userId`, `status`, `role` or a storage key.
- **Not found over forbidden.** Another user's conversation, message, turn, file, project,
  image or share id is a plain 404, indistinguishable from a missing one.
- **Clients reference files by id.** Storage keys are made by the server
  (`storageKeyFor`), stored in `files.storage_key` and never accepted from or returned to a
  client ([files.md](files.md)).
- **Conditional updates for state machines.** File status (`PENDING` to `PROCESSING` to
  `READY`), suspensions, share revocation and title writes (`WHERE title_locked = false`)
  move with `UPDATE ... WHERE <expected>` and check the row count.
- **Effects after commit.** `withTransaction` and `withEffects`
  ([`core/effects.ts`](../../apps/api/src/core/effects.ts)) queue `fx.job(...)` closures and
  run them only after a successful commit; a failing effect is logged, never fails the
  request.
- **Audit inside the transaction** for admin actions, account lifecycle and settings
  ([`services/audit.service.ts`](../../apps/api/src/services/audit.service.ts)).
- **Nothing a person wrote reaches a log line** ([ADR 0012](adr/0012-no-conversation-text-in-logs.md)).

## 3. Auth and sessions

| Piece | Where | Rule |
| --- | --- | --- |
| Passwords | [`security/passwords.ts`](../../apps/api/src/security/passwords.ts) | bcrypt (`BCRYPT_ROUNDS`, 12); 10 to 128 characters, not one repeated character, not containing the email local part or the username |
| Access token | [`security/tokens.ts`](../../apps/api/src/security/tokens.ts) | HS256 JWT with `sub` and `ver` (`token_version`), audience `open-chat`, issuer `open-chat-api`, `ACCESS_TOKEN_TTL_SECONDS` (900). Kept in browser memory only ([`apps/web/src/lib/session.ts`](../../apps/web/src/lib/session.ts)) |
| Refresh token | [`controllers/auth.controller.ts`](../../apps/api/src/controllers/auth.controller.ts) | Random token in the `chat_refresh` cookie: `httpOnly`, `SameSite=Lax`, `Path=/api/auth`, `Secure` per `COOKIE_SECURE`, `REFRESH_TOKEN_TTL_DAYS` (30). Only its SHA-256 is stored in `sessions` |
| Native mode | same | `X-Client: native`: the refresh token is returned in the body (`IssuedNativeSession`) and sent back in the body of `/auth/refresh` and `/auth/logout`; no cookie is ever set ([ADR 0013](adr/0013-native-token-mode.md)) |
| Rotation | [`services/auth.service.ts`](../../apps/api/src/services/auth.service.ts) | Each refresh issues a new token in the same `family_id`. A rotated token presented 10 s or more after its rotation revokes the family; within 10 s it is a benign double refresh (two tabs) |
| Sign-in throttling | same | Two failure budgets in Redis: 5 per account and IP per 15 minutes (`login-fail-pair`), 50 per account per hour (`login-fail-account`). Once spent, every attempt answers `429 RATE_LIMITED`, right password or not; unknown logins are counted the same way |
| Two-factor | [`security/totp.ts`](../../apps/api/src/security/totp.ts) | TOTP secrets AES-256-GCM encrypted with `TOTP_ENCRYPTION_KEY`; a code works once (`totp_last_step`); ten recovery codes stored as HMACs |
| Email verification | `auth.service.ts` | `REQUIRE_EMAIL_VERIFICATION` (default true): sign-up answers 202 and the account is `PENDING_VERIFICATION` until the 24 h link is used |
| Registration | `settings.registration` | `OPEN`; `INVITE_ONLY` (only addresses at `allowedEmailDomains` or their subdomains, else `403 REGISTRATION_DOMAIN_NOT_ALLOWED`); `CLOSED` (`403 REGISTRATION_CLOSED`) |
| Every request | `middleware/auth.ts` | The user row is reloaded: a `token_version` bump (sign out everywhere, password change, ban, erase) or a ban takes effect on the next request; a timed suspension that has run out is lifted lazily |

## 4. Modules

### 4.1 Conversations and turns

[`services/chat/chat.service.ts`](../../apps/api/src/services/chat/chat.service.ts),
[`services/chat/turns.ts`](../../apps/api/src/services/chat/turns.ts),
[`repositories/chat.repository.ts`](../../apps/api/src/repositories/chat.repository.ts),
[`presenters/chat.presenter.ts`](../../apps/api/src/presenters/chat.presenter.ts).

- Lists are keyset pages on `(last_message_at, id)`; `q` matches titles (`ILIKE`, with `%`,
  `_` and `\` escaped) or message text (the generated `messages.search` tsvector with
  `websearch_to_tsquery`). Filters: `projectId`, `archived`, `pinned`.
- `GET /api/chats/:id` returns the branch on screen (the path from the root to
  `current_leaf_id`, a recursive CTE) with each message's `siblingIds`, and `activeTurnId`
  when an answer is still `STREAMING`.
- One turn per conversation at a time: a send or regenerate while one is streaming is
  `409 TURN_IN_PROGRESS`.
- Sends, regenerations, leaf switches and the engine are described in
  [chat-engine.md](chat-engine.md); streaming in
  [streaming-and-resume.md](streaming-and-resume.md).
- Deleting a conversation cancels its running turn first; messages and file links cascade;
  files nobody references any more go with `maintenance.expire-files`.

### 4.2 Models and providers

[`services/models.service.ts`](../../apps/api/src/services/models.service.ts) is the only
reader of the catalogue at runtime. A model is offered when it is enabled, its provider is
enabled, and the provider is usable: it has a key in config, or is `STUB` or
`OPENAI_COMPATIBLE` (a keyless local server is fine). The resolved rows are cached per
process for 5 s. Resolution order for a turn: the model asked for, the user's
`default_model_id`, the deployment default (`is_default`), the first usable one. Details:
[providers.md](providers.md).

### 4.3 Files

[`services/file.service.ts`](../../apps/api/src/services/file.service.ts),
[`domain/file-rules.ts`](../../apps/api/src/domain/file-rules.ts),
[`integrations/extract.ts`](../../apps/api/src/integrations/extract.ts),
[`integrations/storage.ts`](../../apps/api/src/integrations/storage.ts). See
[files.md](files.md).

### 4.4 Projects and memories

- Projects ([`services/project.service.ts`](../../apps/api/src/services/project.service.ts)):
  at most 100 per user, 50 knowledge files each (`PROJECT_LIMIT`, `PROJECT_FILE_LIMIT`).
  A project's instructions are layered into the system prompt for its chats; its files are
  searchable by `search_project_files`. Deleting a project keeps its chats (they move out
  of it).
- Memories ([`services/memory.service.ts`](../../apps/api/src/services/memory.service.ts)):
  at most 200 per user (`MEMORY_LIMIT`); written by the user or by the `remember` tool
  (source `ASSISTANT`, case-insensitive duplicates skipped); the 60 newest are put in the
  system prompt when memory is on in both the settings and the user's preferences.

### 4.5 Images

[`services/image.service.ts`](../../apps/api/src/services/image.service.ts) is the image
studio and gallery (`/api/images`, 10 generations a minute). Generation itself is
`makeImage` in [`services/chat/tools.ts`](../../apps/api/src/services/chat/tools.ts),
shared with the `generate_image` tool and image-mode turns: moderation, an atomic image
reservation against the daily allowance, the provider call, storage as a `GENERATED` file
with a thumbnail, then an `images` row. Editing passes a source image (`sourceImageId` in
the studio, an attached image in an image-mode turn).

### 4.6 Speech

[`services/speech.service.ts`](../../apps/api/src/services/speech.service.ts): dictation
takes raw audio (at most 25 MB, sniffed like an upload) and answers `{ text }` through the
default `TRANSCRIBE` model; read aloud strips Markdown from one of the user's answers (at
most 4000 characters) and streams MP3 from the default `SPEECH` model. Audio is never
stored. Both count estimated tokens times the model weight against the allowance.

### 4.7 Shares

[`services/share.service.ts`](../../apps/api/src/services/share.service.ts),
[ADR 0010](adr/0010-frozen-share-snapshots.md). A share is a frozen copy of the branch on
screen with a 128-bit random id; images are served only through the share-scoped redirect.
A link stops working when revoked (by its owner or an admin), expired, when sharing is
turned off, or when the owner is banned or erased.

### 4.8 Quotas

[`services/quota.service.ts`](../../apps/api/src/services/quota.service.ts). See
[quotas.md](quotas.md).

### 4.9 Accounts

[`services/account.service.ts`](../../apps/api/src/services/account.service.ts),
[`services/user.service.ts`](../../apps/api/src/services/user.service.ts),
[`services/preferences.service.ts`](../../apps/api/src/services/preferences.service.ts).

- Display names are cleaned at write time: never an email address or a phone number
  ([`domain/display-name.ts`](../../apps/api/src/domain/display-name.ts)).
- Export (`GET /api/users/me/export`, 3 a day): account, preferences, conversations and
  messages, projects, memories, images, file metadata and shared links as JSON.
- Deletion (`DELETE /api/users/me` with the password and, when enrolled, a second factor):
  signs out everywhere and erases the account after 14 days (`DELETION_GRACE_DAYS`) unless
  the user signs in again. The last active admin cannot delete themselves
  (`409 LAST_ADMIN`).
- `anonymiseUser` (used by the purge job and admin erase) replaces identity fields with
  placeholders, revokes sessions, bumps `token_version` and deletes shares, images,
  conversations, projects, memories, preferences and overrides; file rows are marked
  `DELETED` until the expiry job removes their objects.

### 4.10 Admin

[`services/admin.service.ts`](../../apps/api/src/services/admin.service.ts),
[`controllers/admin.controller.ts`](../../apps/api/src/controllers/admin.controller.ts).
Every call starts with `requireAdmin` (`403 FORBIDDEN_ADMIN`).

| Area | Rules |
| --- | --- |
| Accounts | Search by name, username or email (trigram index); role changes (`409 LAST_ADMIN`, `403 SELF_ACTION`); suspend 1 to 365 days, ban (sessions revoked, shares revoked), erase now (20 an hour). Admins must be demoted before they can be suspended or banned (`403 TARGET_PROTECTED`) |
| Tiers and overrides | Create, edit, delete tiers (exactly one default, `TIER_DEFAULT_REQUIRED`, `409 TIER_IS_DEFAULT`); put a user on a tier; per-user override of daily tokens and images with a note |
| Providers and models | CRUD; `OPENAI_COMPATIBLE` needs a base URL; `STUB` is refused in production (`STUB_IN_PRODUCTION`); `keyConfigured` is reported, never the key; `POST /models/:id/test` makes one 16-token call and answers a fixed message per failure class (20 a minute) |
| Settings | Any subset of `ChatSettings`, groups merged key by key; `INVITE_ONLY` needs at least one domain; audited with before and after values of changed keys |
| Integrations | What the server has configured for search, moderation, speech, mail and storage; never a key |
| Shares | Every live link (or all with `includeRevoked`), revoke with a reason |
| Audit and stats | The audit trail with prefix filters; usage stats over a UTC date range of at most a year |

### 4.11 Meta

`GET /api/meta` ([`services/meta.service.ts`](../../apps/api/src/services/meta.service.ts))
is public: app name, tagline, registration mode, feature flags (each one already combined
with whether the server can actually do it: `webSearch` needs a configured search
provider, `imageGeneration` an IMAGE model, `dictation` a TRANSCRIBE model, `readAloud` a
SPEECH model), limits (max file MB of the default tier, files per message, message length,
accepted MIME types), the support email and `minSupportedVersion`. Never a key or a
provider name.

## 5. The pure domain functions

| File | Rules |
| --- | --- |
| [`domain/file-rules.ts`](../../apps/api/src/domain/file-rules.ts) | MIME allowlist per purpose, extension must match the type, per-kind size ceilings, magic-byte sniffers (JPEG, PNG, GIF, WebP, HEIC, PDF, ZIP-based Office, audio containers, UTF-8 text), text formats stored as `text/plain`, server-made storage keys |
| [`domain/chunking.ts`](../../apps/api/src/domain/chunking.ts) | `estimateTokens` (4 characters per token), cleaning extracted text, `capText`, `chunkText` (about 1600 characters with 200 of overlap, cut at paragraph or sentence ends) |
| [`domain/net-guard.ts`](../../apps/api/src/domain/net-guard.ts) | `isPublicAddress` (only public unicast, IPv4 unwrapped from mapped, 6to4 and NAT64 IPv6) and `checkUrlShape` (http(s), default ports, no credentials, no `localhost`, `.local`, `.internal`) |
| [`domain/display-name.ts`](../../apps/api/src/domain/display-name.ts), [`domain/username.ts`](../../apps/api/src/domain/username.ts) | Name cleaning, reserved usernames |

Each has unit tests in [`apps/api/test/unit`](../../apps/api/test/unit).

## 6. Background jobs: `JOBS_MODE`

Jobs are named handlers with a JSON payload
([`jobs/registry.ts`](../../apps/api/src/jobs/registry.ts)); the queue is the first
segment of the name. Defaults: 5 attempts with exponential backoff from 5 s.

| | `JOBS_MODE=queue` (default, every deployment) | `JOBS_MODE=inline` (tests, tiny installs) |
| --- | --- | --- |
| Where handlers run | The worker process (concurrency: files 4, chat 8, maintenance 2) | The API process, right after commit |
| Retries | 5 attempts | None: an error is logged and swallowed |
| Scheduled jobs | Registered by every worker, one schedule each | None |
| Production guard | OK | Refused by `assertProductionConfig` |

Turns are not jobs: they run in the API task that accepted the send
([ADR 0005](adr/0005-turns-decoupled-via-redis-streams.md)).

## 7. Rate limits

Redis-backed ([`middleware/rate-limit.ts`](../../apps/api/src/middleware/rate-limit.ts)),
keyed by user when signed in and by IP otherwise, with an in-memory insurance limiter of
the same budget when Redis is unavailable. `RATE_LIMITS=off` disables them (the default
under `NODE_ENV=test`).

| Name | Budget | Where |
| --- | --- | --- |
| `auth` | 10 a minute per IP | sign-up, verify, login, reset, change password, TOTP changes |
| `auth-mail` | 5 an hour per IP | resend verification, forgot password |
| `auth-refresh` | 60 a minute per IP | refresh |
| `login-fail-pair`, `login-fail-account` | 5 per account and IP per 15 min, 50 per account per hour | failed sign-ins |
| `turns` | 30 a minute per user | send, regenerate |
| `file-create` | 60 per 10 minutes per user | `POST /api/files` |
| `file-upload` | 200 an hour per user | inside `createFile` |
| `images` | 10 a minute per user | image studio |
| `dictation` | 20 a minute per user | transcribe |
| `tts` | 30 a minute per user | read aloud |
| `shared-read`, `shared-image` | 120 and 600 a minute per IP | public share page and its images |
| `account-delete`, `account-export` | 5 an hour, 3 a day per user | account deletion and export |
| `admin-erase`, `admin-model-test` | 20 an hour, 20 a minute per admin | admin erase and model test |

A spent budget answers `429 RATE_LIMITED` with `Retry-After` and
`details.retryAfterSeconds`. Daily allowances are separate ([quotas.md](quotas.md)).

## 8. Errors

Every error body is `{ error, code, details?, requestId }`
([`core/errors.ts`](../../apps/api/src/core/errors.ts)). `code` is stable and the clients
switch on it; `error` is for people and may change. Body-parser failures become
`400 BAD_REQUEST` or `413 PAYLOAD_TOO_LARGE`; anything unexpected is logged with the
request id and answered `500 INTERNAL` with no detail. Errors inside a running turn are
not HTTP errors: they arrive as an `error` event with a `TurnErrorCode` and a fixed safe
message ([streaming.md](../api/streaming.md)). The full table is in
[rest-contract.md](../api/rest-contract.md).

## 9. File map for the chat path

| Concern | File |
| --- | --- |
| Routes for sending, branches, turns | [`routes/chats.routes.ts`](../../apps/api/src/routes/chats.routes.ts), [`routes/messages.routes.ts`](../../apps/api/src/routes/messages.routes.ts), [`routes/turns.routes.ts`](../../apps/api/src/routes/turns.routes.ts) |
| Request parsing and SSE response | [`controllers/chat.controller.ts`](../../apps/api/src/controllers/chat.controller.ts), [`middleware/sse.ts`](../../apps/api/src/middleware/sse.ts) |
| Sends, regenerate, leaf, feedback, replay | [`services/chat/chat.service.ts`](../../apps/api/src/services/chat/chat.service.ts) |
| The engine | [`services/chat/turns.ts`](../../apps/api/src/services/chat/turns.ts) |
| Context window fitting | [`services/chat/context.ts`](../../apps/api/src/services/chat/context.ts) |
| System prompt layers | [`services/chat/prompt.ts`](../../apps/api/src/services/chat/prompt.ts) |
| Tools | [`services/chat/tools.ts`](../../apps/api/src/services/chat/tools.ts) |
| Event log, follow, cancel | [`services/chat/event-log.ts`](../../apps/api/src/services/chat/event-log.ts) |
| Titles and the rolling summary | [`services/chat/titles.ts`](../../apps/api/src/services/chat/titles.ts), [`services/chat/summary.ts`](../../apps/api/src/services/chat/summary.ts) |
| Provider adapters | [`integrations/llm/`](../../apps/api/src/integrations/llm/index.ts), [`integrations/http.ts`](../../apps/api/src/integrations/http.ts) |
| Event types | [`packages/types/src/events.ts`](../../packages/types/src/events.ts) |
| Browser side | [`apps/web/src/lib/chat/turn-runner.ts`](../../apps/web/src/lib/chat/turn-runner.ts), [`packages/api-client/src/stream.ts`](../../packages/api-client/src/stream.ts) |
