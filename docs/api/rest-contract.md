# REST contract

Every route the API serves, the DTO it returns (`packages/types`), and the router file that
owns it (`apps/api/src/routes`). The generated OpenAPI document
([`openapi.yaml`](openapi.yaml), `pnpm openapi`) is built from the route files' doc
comments; this page is the human map. Turn event streams have their own page:
[streaming.md](streaming.md).

## Conventions

- **Base path** `/api`. JSON in and out, except the SSE streams, dictation (raw audio in)
  and read aloud (audio out).
- **Errors**: every non-2xx body is `ApiError`:
  `{ "error": "Human message", "code": "STABLE_CODE", "details": { ... }, "requestId": "..." }`.
  Switch on `code`; `error` may change. `requestId` matches the `X-Request-Id` response
  header and the server's log line.
- **Status codes**: creates answer **201** with the created resource; deletes and
  fire-and-forget actions answer **204** with no body; a send answers **202** (or streams).
- **Strict bodies**: every body schema is `.strict()`; an unknown key is
  `400 VALIDATION_FAILED` with `details.fields: [{ path, message }]`.
- **Ids** in paths are ULIDs (26 characters, Crockford base32), except provider slugs and
  share ids (22 characters, base64url). A malformed id is `400 VALIDATION_FAILED`.
- **Ownership**: another account's conversation, message, turn, file, project, memory,
  image or share is **404**, never 403.
- **Writes need an ACTIVE account**: a suspended account can read but gets
  `403 ACCOUNT_RESTRICTED` on writes.
- **Auth column**: `auth` = bearer token required, `public` = none, `admin` = bearer token
  of an ACTIVE `ADMIN` (`403 FORBIDDEN_ADMIN` otherwise), `cookie` / `body token` = the
  refresh token.

## Auth modes

| Mode | Access token | Refresh token |
| --- | --- | --- |
| Web (default) | `Authorization: Bearer <token>`, from the body of every session response; keep it in memory | `chat_refresh` cookie: httpOnly, `SameSite=Lax`, `Path=/api/auth`, `Secure` on https |
| Native (`X-Client: native` on auth requests) | Same | Returned in the body as `refreshToken` with `refreshExpiresAt` (ISO); sent back as `{ refreshToken }` to `/auth/refresh` and `/auth/logout`; no cookie is ever set ([ADR 0013](../architecture/adr/0013-native-token-mode.md)) |

Access tokens last `ACCESS_TOKEN_TTL_SECONDS` (900); refresh tokens
`REFRESH_TOKEN_TTL_DAYS` (30) and rotate on every use. A 401 with `TOKEN_INVALID` means
"refresh and retry"; a 401 `SESSION_EXPIRED` from `/auth/refresh` means "sign in again".
The api-client does this single-flight, with a cross-tab lock
([`packages/api-client/src/http.ts`](../../packages/api-client/src/http.ts)).

## Pagination

Lists are keyset pages: `Page<T>` is `{ items: T[], nextCursor: string | null }` with
`?cursor=&limit=`. Cursors are opaque base64url strings (at most 300 characters; a
tampered one is `400 INVALID_CURSOR`); pass `nextCursor` back unchanged until it is null.
There are no totals and no `OFFSET`.

| List | Default and max `limit` |
| --- | --- |
| `GET /chats` | 30, 100 |
| `GET /images` | 60 max |
| Admin lists (`/admin/users`, `/admin/shares`, `/admin/audit`) | 30, 100 |

A few small, bounded lists are plain arrays (`T[]`): files (at most 200), projects (100),
memories (200), shares (200), tiers, providers, models, sessions.

## Core: `auth.routes.ts`, `users.routes.ts`, `meta.routes.ts`, `me.routes.ts`, `models.routes.ts`

| Method | Path | Auth | Returns |
| --- | --- | --- | --- |
| POST | /auth/signup `{ email, username, displayName, password }` | public | **201** `AuthResult` (+ cookie or `IssuedNativeSession`), or **202** `{ verificationRequired: true, email }`; 403 `REGISTRATION_CLOSED`, `REGISTRATION_DOMAIN_NOT_ALLOWED`; 409 `EMAIL_TAKEN`, `USERNAME_TAKEN`, `USERNAME_RESERVED`; 400 `WEAK_PASSWORD`, `DISPLAY_NAME_INVALID` |
| POST | /auth/verify-email `{ token }` | public | `AuthResult`; 400 `TOKEN_INVALID` |
| POST | /auth/resend-verification `{ email }`, /auth/forgot-password `{ email }` | public | **202** `{ ok: true }` (the same whether or not the account exists) |
| POST | /auth/login `{ login, password, totp? \| recoveryCode? }` | public | `AuthResult`, or `{ totpRequired: true }`; 401 `INVALID_CREDENTIALS`, `INVALID_TOTP`; 403 `EMAIL_NOT_VERIFIED`, `ACCOUNT_BANNED`; 429 once a failure budget is spent |
| POST | /auth/refresh | cookie | `AuthResult` with a rotated cookie; **204** without a cookie; 401 `SESSION_EXPIRED` |
| POST | /auth/refresh `{ refreshToken }` + `X-Client: native` | body token | `IssuedNativeSession` (rotated); 401 `SESSION_EXPIRED` |
| POST | /auth/logout | cookie, or `{ refreshToken }` native | 204 |
| POST | /auth/logout-all | auth | 204 (every session revoked, `token_version` bumped) |
| POST | /auth/reset-password `{ token, password }` | public | 204 (sessions revoked) |
| POST | /auth/change-password `{ currentPassword, newPassword }` | auth | 204 (every session revoked; sign in again) |
| GET | /auth/me | auth | `Me` |
| POST | /auth/totp/setup | auth | `{ secret, otpauthUrl }` |
| POST | /auth/totp/enable `{ code }` | auth | `{ recoveryCodes }` (ten, shown once) |
| POST | /auth/totp/disable `{ password, code \| recoveryCode }` | auth | 204 |
| POST | /auth/totp/recovery-codes `{ password, code }` | auth | `{ recoveryCodes }` |
| GET | /users/me | auth | `Me` (identity, status, whether `/admin` is open to you) |
| PATCH | /users/me `{ displayName?, avatarFileId? }` | auth | `Me`; the avatar must be your `READY` AVATAR file |
| DELETE | /users/me `{ password, totp? \| recoveryCode? }` | auth | `{ purgeAfter }` (14 days); 409 `LAST_ADMIN` |
| GET | /users/me/export | auth | JSON download (3 a day) |
| GET | /users/me/sessions | auth | `SessionInfo[]` |
| DELETE | /users/me/sessions/:id | auth | 204 |
| GET | /meta | public | `AppMeta`: name, tagline, registration, feature flags (already combined with what the server can do), limits, support email, `minSupportedVersion`; cached 30 s |
| GET | /models | auth | `ModelCatalog`: usable chat models with capabilities and weight, and the image model (or null) |
| GET | /me/usage | auth | `Usage`: today's tokens and images against the limits, `maxFileMb`, `resetsAt` |
| GET, PATCH | /me/preferences | auth | `Preferences`; PATCH takes any of `aboutMe`, `customInstructions`, `answerStyle`, `memoryEnabled`, `webSearchDefault`, `defaultModelId`, `voice` (400 `VOICE_UNKNOWN`) |

The exact field names of every body are in [`openapi.yaml`](openapi.yaml) and the zod
schemas in [`apps/api/src/controllers/`](../../apps/api/src/controllers/auth.controller.ts).

## Chat: `chats.routes.ts`, `messages.routes.ts`, `turns.routes.ts`

| Method | Path | Auth | Returns |
| --- | --- | --- | --- |
| GET | /chats?cursor&limit&q&projectId&archived&pinned | auth | `Page<ConversationSummary>`, most recent first; `q` matches titles and message text |
| POST | /chats `{ title?, projectId? }` | auth | **201** `ConversationSummary` (most clients send to `new` instead) |
| DELETE | /chats | auth | `{ deleted }` (every conversation) |
| GET | /chats/:id | auth | `ConversationDetail`: the branch on screen, `currentLeafId`, each message's `siblingIds`, and `activeTurnId` while an answer is being written |
| PATCH | /chats/:id `{ title?, pinned?, archived?, projectId? }` | auth | `ConversationSummary` (a title locks it against auto-titling) |
| DELETE | /chats/:id | auth | 204 (a running answer is cancelled) |
| POST | /chats/:id/messages | auth | **202** `TurnStarted`, or the event stream with `Accept: text/event-stream` ([streaming.md](streaming.md)) |
| PUT | /chats/:id/leaf `{ messageId }` | auth | `ConversationDetail` on the branch through that message |
| POST | /messages/:id/regenerate `{ modelId?, webSearch? }` | auth | **202** `TurnStarted` or the event stream; a sibling answer |
| PUT | /messages/:id/feedback `{ value: 1 \| -1 \| null }` | auth | `Message` |
| GET | /messages/:id/speech | auth | `audio/mpeg` stream (read aloud); 503 `MODEL_UNAVAILABLE`; 403 `READ_ALOUD_DISABLED` |
| GET | /turns/:id/events?after=<seq> | auth | `text/event-stream` from `after` (or `Last-Event-ID`), ends after `done` |
| POST | /turns/:id/cancel | auth | 204 (partial answer kept, status `CANCELLED`) |

`SendMessageInput`:

```json
{
  "content": "Compare these two quotes and draw a chart",
  "fileIds": ["01JDXP0V6Y2K8S3M4N5Q6R7T8V"],
  "parentId": "01JDXNZZ9A1B2C3D4E5F6G7H8J",
  "modelId": "01JDK4V7Q8A0B1C2D3E4F5G6H7",
  "webSearch": true,
  "mode": "chat",
  "aspectRatio": "1:1",
  "projectId": null
}
```

| Field | Rule |
| --- | --- |
| `content` | At most 32000 characters; empty only with files; required in image mode |
| `fileIds` | At most 10; your own `ATTACHMENT` or `PROJECT` files, `READY` |
| `parentId` | Omitted: continue the branch on screen. An assistant message id: edit (a new branch). `null`: a new first question |
| `modelId` | A usable chat model; omitted uses your default, then the deployment default |
| `webSearch` | Omitted uses your `webSearchDefault` |
| `mode` | `chat` (default) or `image` |
| `aspectRatio` | `1:1`, `4:3`, `3:4`, `16:9`, `9:16` (image mode) |
| `projectId` | Only with `:id = new`: start the chat in that project |

Send errors: 409 `TURN_IN_PROGRESS`; 400 `MESSAGE_EMPTY`, `MESSAGE_TOO_LONG`,
`TOO_MANY_FILES`, `FILE_NOT_FOUND`, `FILE_REJECTED`, `PARENT_INVALID`, `MODEL_NO_VISION`,
`IMAGES_UNAVAILABLE`; 409 `FILE_NOT_READY`; 404 `CONVERSATION_NOT_FOUND`,
`PROJECT_NOT_FOUND`; 503 `MODEL_UNAVAILABLE`; 429 `RATE_LIMITED` (30 a minute). Problems
that happen while the answer is written (quota, provider, moderation) are `error` events,
not HTTP errors.

`TurnStarted`: `{ turnId, conversationId, userMessageId, assistantMessageId }`
(`userMessageId` is null for a regeneration). `turnId` equals `assistantMessageId`.

## Files: `files.routes.ts`

| Method | Path | Auth | Returns |
| --- | --- | --- | --- |
| POST | /files `{ purpose: AVATAR\|ATTACHMENT\|PROJECT, fileName, mimeType, sizeBytes }` | auth | `UploadTicket` `{ file, uploadUrl, headers, expiresAt }`; 413 `FILE_TOO_LARGE`; 400 `FILE_TYPE_NOT_ALLOWED`, `FILE_EXTENSION_MISMATCH`, `FILE_PURPOSE_MISMATCH`, `FILE_EMPTY` |
| GET | /files?purpose= | auth | `ChatFile[]` (newest first) |
| GET | /files/:id | auth | `ChatFile` (poll until `READY` or `REJECTED` with `rejectedReason`) |
| POST | /files/:id/complete | auth | `ChatFile` (`PROCESSING` or `READY`); 400 `UPLOAD_MISSING`, `FILE_SIZE_MISMATCH`, `FILE_TYPE_MISMATCH` |
| DELETE | /files/:id | auth | 204; 409 `FILE_IN_USE` when sent in a message |
| PUT, GET | /files/local/:token | signed token | `STORAGE=local` only: the stand-in for presigned PUT and GET; 403 `UPLOAD_LINK_INVALID`, `UPLOAD_LINK_MISMATCH`, `FILE_LINK_INVALID` |

### Upload flow

1. `POST /api/files` with the declared name, type and size. The response's `uploadUrl` is a
   presigned PUT valid 10 minutes.
2. `PUT uploadUrl` with the body bytes and **exactly** the returned `headers`
   (`Content-Type`; S3 also signs `Content-Length`, which the client sets from the body).
3. `POST /api/files/:id/complete`. The server checks the stored size and magic bytes.
4. Poll `GET /api/files/:id` until `status` is `READY` (images are re-encoded, documents
   read and indexed) or `REJECTED`.
5. Send the id in `fileIds`, `avatarFileId` or `POST /projects/:id/files`.

The api-client's `files.upload({ purpose, file, onProgress })` does all five with upload
progress ([`packages/api-client/src/upload.ts`](../../packages/api-client/src/upload.ts)).
`ChatFile.url` and `thumbUrl` are signed GET URLs valid 15 minutes; refetch the file (or
the conversation) for fresh ones. Details: [files.md](../architecture/files.md).

## Projects, memories, images, shares, speech: `projects.routes.ts`, `memories.routes.ts`, `images.routes.ts`, `shares.routes.ts`, `shared.routes.ts`, `speech.routes.ts`

| Method | Path | Auth | Returns |
| --- | --- | --- | --- |
| GET | /projects | auth | `Project[]` |
| POST | /projects `{ name, instructions? }` | auth | **201** `ProjectDetail`; 409 `PROJECT_LIMIT` (100) |
| GET, PATCH, DELETE | /projects/:id | auth | `ProjectDetail`; DELETE 204 (chats stay, outside any project; knowledge files removed) |
| POST | /projects/:id/files `{ fileId }` | auth | `ProjectDetail`; the file must be a PROJECT upload; 409 `PROJECT_FILE_LIMIT` (50) |
| DELETE | /projects/:id/files/:fileId | auth | `ProjectDetail` |
| GET | /memories | auth | `Memory[]`, newest first |
| POST | /memories `{ content }` | auth | **201** `Memory`; 409 `MEMORY_LIMIT` (200) |
| PATCH, DELETE | /memories/:id | auth | `Memory`; 204 |
| DELETE | /memories | auth | 204 (forget everything) |
| GET | /images?cursor&limit | auth | `Page<GeneratedImage>` |
| POST | /images `{ prompt, aspectRatio?, sourceImageId? }` | auth | **201** `GeneratedImage`; 429 `QUOTA_EXCEEDED`; 400 `CONTENT_BLOCKED`, `IMAGES_UNAVAILABLE`; 502 `PROVIDER_ERROR`; 10 a minute |
| DELETE | /images/:id | auth | 204 (an image shown in a chat stays there) |
| POST | /shares `{ conversationId, expiresInDays? }` (1 to 365) | auth | **201** `Share` with `url`; 400 `SHARE_EMPTY`; 403 `SHARING_DISABLED` |
| GET | /shares | auth | `Share[]` |
| DELETE | /shares/:id | auth | 204 (the link stops working at once) |
| GET | /shared/:id | public | `SharedConversation` (the frozen snapshot); 404 `SHARE_NOT_FOUND` when revoked, expired or unknown; 120 a minute per IP |
| GET | /shared/:id/images/:fileId | public | **302** to a short-lived signed URL, only for images frozen into the snapshot; 600 a minute per IP |
| POST | /speech/transcribe?language= | auth | `{ text }`; body is the raw audio with its `Content-Type` (webm, ogg, mp3, m4a, wav; at most 25 MB); 400 `AUDIO_TYPE_NOT_ALLOWED`, `AUDIO_TYPE_MISMATCH`, `AUDIO_EMPTY`; 403 `DICTATION_DISABLED`; 503 `MODEL_UNAVAILABLE`; 429 `QUOTA_EXCEEDED` |

## Admin: `admin.routes.ts`

All `admin`. Admins see accounts, usage and configuration, never conversations.

| Method | Path | Returns |
| --- | --- | --- |
| GET | /admin/me | `AdminSession` |
| GET | /admin/stats?from=&to= | `AdminStats` (UTC dates, default the last 30 days, at most a year: 400 `RANGE_TOO_LONG`) |
| GET | /admin/users?q&status&role&tierId&cursor&limit | `Page<AdminUserRow>` |
| GET | /admin/users/:id | `AdminUserDetail` (tier, override, totals, 30 days of usage) |
| PATCH | /admin/users/:id/role `{ role }` | `AdminUserRow`; 403 `SELF_ACTION`; 409 `LAST_ADMIN` |
| POST | /admin/users/:id/suspend `{ days, reason? }`, /unsuspend | `AdminUserRow`; 400 `DAYS_INVALID`; 403 `TARGET_PROTECTED`; 409 `INVALID_STATUS`, `USER_ERASED` |
| POST | /admin/users/:id/ban `{ reason? }`, /unban | `AdminUserRow` (ban: signed out everywhere, shared links revoked) |
| POST | /admin/users/:id/erase `{ reason }` | 204; 409 `ALREADY_ERASED`; 20 an hour |
| PUT | /admin/users/:id/tier `{ tierId }` | `AdminUserRow` (null = the default tier) |
| PUT, DELETE | /admin/users/:id/quota `{ dailyTokens, dailyImages, note }` | `AdminUserDetail` |
| GET | /admin/tiers | `QuotaTier[]` with account counts |
| POST | /admin/tiers `{ name, dailyTokens, dailyImages, maxFileMb, isDefault? }` | every tier; 409 `TIER_NAME_TAKEN`; 400 `TIER_DEFAULT_REQUIRED` |
| PUT, DELETE | /admin/tiers/:id | every tier; 409 `TIER_IS_DEFAULT` |
| GET | /admin/providers | `AdminProvider[]` with `keyConfigured` (never the key) |
| POST | /admin/providers `{ id, kind, displayName, baseUrl, enabled }` | every provider; 409 `PROVIDER_SLUG_TAKEN`; 400 `BASE_URL_REQUIRED`, `BASE_URL_INVALID`, `STUB_IN_PRODUCTION` |
| PUT, DELETE | /admin/providers/:id | every provider |
| GET | /admin/models | `AdminModel[]` |
| POST | /admin/models, PUT /admin/models/:id | every model; 409 `MODEL_DUPLICATE` |
| DELETE | /admin/models/:id | every model |
| POST | /admin/models/:id/test | `ModelTestResult` `{ ok, latencyMs, message }` (one 16-token call; 20 a minute) |
| GET, PATCH | /admin/settings | `ChatSettings` (PATCH: any subset, groups merged key by key; 400 `SETTINGS_INVALID`) |
| GET | /admin/integrations | `IntegrationStatus` (search, moderation, speech, mail, storage; never a key) |
| GET | /admin/shares?includeRevoked&cursor&limit | `Page<AdminShareRow>` |
| POST | /admin/shares/:id/revoke `{ reason }` | 204 |
| GET | /admin/audit?action&actorId&entityType&entityId&cursor&limit | `Page<AuditEntry>`, newest first (`action` is a prefix) |

## Health

| Method | Path | Returns |
| --- | --- | --- |
| GET | /up | `{ ok: true }` (liveness, not under `/api`) |
| GET | /api/ready | `{ ok: true }` when Postgres and Redis answer, else **503** `{ ok: false }` (the load balancer check) |

## Error codes

Generic codes come from the status ([`apps/api/src/core/errors.ts`](../../apps/api/src/core/errors.ts));
specific ones are thrown by services.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | A body, query or path failed its schema; `details.fields` |
| 400 | `BAD_REQUEST` | Malformed JSON |
| 400 | `INVALID_CURSOR` | A cursor was edited or truncated |
| 400 | `MESSAGE_EMPTY`, `MESSAGE_TOO_LONG`, `TOO_MANY_FILES`, `PARENT_INVALID` | Send rules |
| 400 | `MODEL_NO_VISION`, `IMAGES_UNAVAILABLE` | The model cannot see images; no image model |
| 400 | `FILE_TYPE_NOT_ALLOWED`, `FILE_EXTENSION_MISMATCH`, `FILE_PURPOSE_MISMATCH`, `FILE_EMPTY` | Declared file rejected |
| 400 | `UPLOAD_MISSING`, `FILE_SIZE_MISMATCH`, `FILE_TYPE_MISMATCH` | Completed upload rejected |
| 400 | `FILE_NOT_FOUND`, `FILE_REJECTED` | An attachment in a send is not usable |
| 400 | `AUDIO_TYPE_NOT_ALLOWED`, `AUDIO_TYPE_MISMATCH`, `AUDIO_EMPTY` | Dictation input |
| 400 | `CONTENT_BLOCKED` | Image studio prompt refused by moderation or the provider |
| 400 | `SHARE_EMPTY` | Nothing to share yet |
| 400 | `WEAK_PASSWORD`, `DISPLAY_NAME_INVALID`, `TOKEN_INVALID`, `TOTP_REQUIRED`, `TOTP_NOT_STARTED`, `TOTP_NOT_ENABLED`, `INVALID_TOTP` | Account rules |
| 400 | `VOICE_UNKNOWN` | Preferences |
| 400 | `DAYS_INVALID`, `RANGE_INVALID`, `RANGE_TOO_LONG`, `SETTINGS_INVALID`, `TIER_DEFAULT_REQUIRED`, `BASE_URL_REQUIRED`, `BASE_URL_INVALID`, `STUB_IN_PRODUCTION` | Admin input |
| 401 | `UNAUTHENTICATED` | No token |
| 401 | `TOKEN_INVALID` | Expired or revoked access token: refresh and retry |
| 401 | `SESSION_EXPIRED` | Refresh token revoked, replayed or expired: sign in again |
| 401 | `INVALID_CREDENTIALS`, `INVALID_TOTP` | Sign-in failed |
| 403 | `ACCOUNT_RESTRICTED` | Suspended: read only |
| 403 | `ACCOUNT_BANNED`, `ACCOUNT_DEACTIVATED`, `EMAIL_NOT_VERIFIED` | Account state |
| 403 | `REGISTRATION_CLOSED`, `REGISTRATION_DOMAIN_NOT_ALLOWED` | Sign-up mode |
| 403 | `FORBIDDEN_ADMIN`, `SELF_ACTION`, `TARGET_PROTECTED` | Admin rules |
| 403 | `SHARING_DISABLED`, `DICTATION_DISABLED`, `READ_ALOUD_DISABLED` | Feature off |
| 403 | `CORS_ORIGIN_DENIED` | A non-GET request from a foreign origin |
| 403 | `UPLOAD_LINK_INVALID`, `UPLOAD_LINK_MISMATCH`, `FILE_LINK_INVALID` | Local storage links |
| 404 | `NOT_FOUND`, `CONVERSATION_NOT_FOUND`, `MESSAGE_NOT_FOUND`, `TURN_NOT_FOUND`, `FILE_NOT_FOUND`, `PROJECT_NOT_FOUND`, `MEMORY_NOT_FOUND`, `IMAGE_NOT_FOUND`, `SHARE_NOT_FOUND`, `USER_NOT_FOUND`, `TIER_NOT_FOUND`, `PROVIDER_NOT_FOUND`, `MODEL_NOT_FOUND` | Missing, or not yours |
| 409 | `TURN_IN_PROGRESS` | An answer is still being written in this chat |
| 409 | `FILE_NOT_READY`, `FILE_IN_USE` | File state |
| 409 | `PROJECT_LIMIT`, `PROJECT_FILE_LIMIT`, `MEMORY_LIMIT` | Caps |
| 409 | `EMAIL_TAKEN`, `USERNAME_TAKEN`, `USERNAME_RESERVED`, `TOTP_ALREADY_ENABLED` | Account conflicts |
| 409 | `LAST_ADMIN`, `INVALID_STATUS`, `USER_ERASED`, `ALREADY_ERASED`, `TIER_IS_DEFAULT`, `TIER_NAME_TAKEN`, `PROVIDER_SLUG_TAKEN`, `MODEL_DUPLICATE` | Admin conflicts |
| 413 | `FILE_TOO_LARGE`, `PAYLOAD_TOO_LARGE` | Over the file limit; JSON over 2 MB |
| 429 | `RATE_LIMITED` | A rate limit; `Retry-After` header and `details.retryAfterSeconds` |
| 429 | `QUOTA_EXCEEDED` | Daily allowance (image studio, dictation, read aloud) |
| 500 | `INTERNAL` | Unexpected; quote the `requestId` |
| 502 | `PROVIDER_ERROR` | Image studio: the provider failed |
| 503 | `MODEL_UNAVAILABLE` | No usable chat (or speech, transcription) model |

Errors inside a running turn are `error` events with a `TurnErrorCode`
([streaming.md](streaming.md#error-codes-inside-a-turn)).

## Idempotency notes

The API has no idempotency-key header. What is safe to repeat:

| Call | Repeat behaviour |
| --- | --- |
| `POST /files/:id/complete` | Safe: a file that is no longer `PENDING` is returned as it is |
| `POST /turns/:id/cancel` | Safe: a no-op once the turn is final |
| `GET /turns/:id/events?after=` | Safe by design: resume from the last `seq` you applied |
| `DELETE` on shares, files, memories, projects | The second call is a 404 |
| `PUT /chats/:id/leaf`, `PUT /messages/:id/feedback`, `PATCH` preferences, settings | Idempotent (last write wins) |
| `POST /chats/:id/messages`, `POST /messages/:id/regenerate` | **Not idempotent**: a retry after a lost response creates another question or answer. The conversation is busy while a turn runs (`409 TURN_IN_PROGRESS`), which limits the damage; a client that lost the response should `GET /chats/:id` and look at `activeTurnId` before resending |
| `POST /images`, `POST /shares`, `POST /memories` | Not idempotent (another image, link or memory). `remember` and `POST /memories` share a cap; the tool skips exact duplicates |

## Rate limits

| Name | Budget | Applies to |
| --- | --- | --- |
| `auth` | 10 a minute per IP | sign-up, verify-email, login, reset and change password, TOTP enable, disable and recovery codes |
| `auth-mail` | 5 an hour per IP | resend verification, forgot password |
| `auth-refresh` | 60 a minute per IP | refresh |
| sign-in failures | 5 per account and IP per 15 minutes; 50 per account per hour | then `429` for every attempt |
| `turns` | 30 a minute per user | send, regenerate |
| `file-create` / `file-upload` | 60 per 10 minutes / 200 an hour per user | `POST /files` |
| `images` | 10 a minute per user | `POST /images` |
| `dictation` / `tts` | 20 / 30 a minute per user | transcribe / read aloud |
| `shared-read` / `shared-image` | 120 / 600 a minute per IP | public share routes |
| `account-delete` / `account-export` | 5 an hour / 3 a day per user | `DELETE /users/me`, export |
| `admin-erase` / `admin-model-test` | 20 an hour / 20 a minute per admin | erase, model test |

Daily allowances (tokens and images) are separate: [quotas.md](../architecture/quotas.md).
