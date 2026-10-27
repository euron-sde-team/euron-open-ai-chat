# Security architecture

The controls Euron Open AI Chat relies on, where each lives in the code, and what it does
not cover. The STRIDE analysis that ties threats to these controls is
[threat-model.md](threat-model.md). How to report a vulnerability:
[SECURITY.md](../../SECURITY.md). Paths are relative to the repository root.

## 1. Authentication

| Control | Where | Detail |
| --- | --- | --- |
| Password hashing | [`apps/api/src/security/passwords.ts`](../../apps/api/src/security/passwords.ts) | bcrypt, cost `BCRYPT_ROUNDS` (12; below 12 refused in production) |
| Password policy | same | 10 to 128 characters, not one repeated character, not containing the email local part or the username (`WEAK_PASSWORD`) |
| Sign-in throttling | [`apps/api/src/services/auth.service.ts`](../../apps/api/src/services/auth.service.ts) | 5 failures per account and IP per 15 minutes and 50 per account per hour; once spent, every attempt is `429` whether the password is right or not. Unknown logins are counted the same way and burn a bcrypt compare, so timing and answers do not reveal which accounts exist |
| Generic answers | same | `INVALID_CREDENTIALS` for an unknown login and a wrong password alike; resend verification and forgot password always answer the same |
| Email verification | same | On by default (`REQUIRE_EMAIL_VERIFICATION`); 24 h single-use links stored as hashes |
| Password reset | same | 1 h single-use links stored as hashes; a reset revokes every session and bumps `token_version` |
| Two-factor | [`apps/api/src/security/totp.ts`](../../apps/api/src/security/totp.ts) | TOTP with the secret AES-256-GCM encrypted under `TOTP_ENCRYPTION_KEY`; each code works once (`totp_last_step`); ten single-use recovery codes stored as HMACs; disabling needs the password and a code |
| Registration control | [`apps/api/src/services/settings.service.ts`](../../apps/api/src/services/settings.service.ts) | `OPEN`, `INVITE_ONLY` (allowed email domains and their subdomains), `CLOSED` |
| Bootstrap admin | [`apps/api/src/services/admin-bootstrap.service.ts`](../../apps/api/src/services/admin-bootstrap.service.ts) | `admin:create` emails a set-password link and never prints a password unless `--print-password` is given (ECS stdout goes to CloudWatch) |

## 2. Sessions, cookies and CSRF

- **Access token**: HS256 JWT (`JWT_SECRET`), 15 minutes, audience `open-chat`, issuer
  `open-chat-api`, carrying `sub` and `ver`. The web app keeps it in module memory only,
  never `localStorage` ([`apps/web/src/lib/session.ts`](../../apps/web/src/lib/session.ts)).
- **Refresh token**: random, 30 days, in the `chat_refresh` cookie (`httpOnly`,
  `SameSite=Lax`, `Path=/api/auth`, `Secure` when the app URL is https). Only its SHA-256
  is stored.
- **Rotation and reuse detection**: every refresh rotates within a family; a rotated token
  presented 10 s or more later revokes the whole family.
- **Every request reloads the user**: a `token_version` mismatch (sign out everywhere,
  password change or reset, ban, erase) invalidates outstanding access tokens immediately.
- **Native token mode**: with `X-Client: native` the refresh token is in the body instead
  of a cookie; same rotation code path; the app keeps it in the platform keystore
  ([ADR 0013](adr/0013-native-token-mode.md)).
- **CSRF**: the only cookie-authenticated endpoints are `/api/auth/refresh` and
  `/api/auth/logout`. They are protected by `SameSite=Lax`, the path scope, CORS
  (credentials only for `CORS_ORIGINS`) and an explicit check that refuses any non-GET
  request with a foreign `Origin` (`403 CORS_ORIGIN_DENIED`,
  [`apps/api/src/app.ts`](../../apps/api/src/app.ts)). Every other endpoint needs the bearer
  token, which a cross-site page cannot read.
- **Session management**: users list and revoke their sessions
  (`/api/users/me/sessions`); sign out everywhere revokes all of them.

## 3. Authorisation

### Roles

`USER` and `ADMIN`. Every admin controller starts with `requireAdmin`
(`403 FORBIDDEN_ADMIN`; a suspended admin has no powers). The web app hides `/admin` from
users, but the API is the boundary ([`apps/api/src/core/context.ts`](../../apps/api/src/core/context.ts)).

### Ownership

Every user-owned record is read with the actor's id in the query: conversations, messages
and turns (`findConversation(actor.id, id)`, `findOwnedMessage`, also for arming a push), files (`ownFile`,
`findOwned`), projects, memories, images and shares. Another account's id is a plain 404,
indistinguishable from a missing one. A file id inside a message is checked with the same
owner-scoped query before the message is stored, so a client cannot attach someone else's
file by guessing its id.

### Admins and conversations

There is no admin endpoint that returns a conversation, a message, a memory, a project's
instructions or a file's content. Admins see accounts, usage counts, configuration, shared
links (which are public by the owner's choice) and the audit trail. Erasing an account
deletes its content without reading it.

### Writes and mass assignment

Strict zod schemas (`.strict()`) on every body; an unknown key is `400 VALIDATION_FAILED`.
Services take explicit field lists. A client cannot send `userId`, `role`, `status`,
`storage_key`, `model weight` or a system prompt. Suspended accounts can read but not
write (`403 ACCOUNT_RESTRICTED`).

## 4. Model providers and keys

- Keys come only from `PROVIDER_KEYS` and the single-key shortcuts in the environment (on
  AWS, the `<prefix>/provider-keys` secret). No table has a key column; no endpoint accepts
  or returns one; admins see `keyConfigured` only
  ([ADR 0004](adr/0004-providers-behind-one-interface.md)).
- Provider error bodies are logged truncated with key-shaped strings masked and are never
  returned; users and admins see fixed messages per failure class
  ([providers.md](providers.md#4-failure-classification)).
- A canary key in the integration suite proves no response contains it.
- `STUB` providers are refused in production.

## 5. Tools, SSRF and prompt injection

Summarised here; details in [tools-and-safety.md](tools-and-safety.md).

- `open_url` checks the URL shape, resolves the host, requires every address to be public,
  pins the connection to the vetted address, follows at most 4 redirects by hand with the
  same checks on every hop, and reads at most 2 MB of text in 12 s
  ([ADR 0008](adr/0008-ssrf-guard-per-hop-with-dns-pinning.md)). `FETCH_ALLOW_HOSTS` is
  refused in production.
- Tool results are `role: "tool"` messages, never system prompt text; external content is
  wrapped and labelled untrusted ([ADR 0007](adr/0007-tool-results-as-tool-messages.md)).
- The system prompt is built on the server; user preferences are fenced and labelled.
- Per turn: 4 model rounds, 8 tool calls.
- Optional moderation of prompts and image prompts (fails open).

## 6. Input handling

| Input | Control |
| --- | --- |
| JSON bodies | 2 MB limit; strict schemas; length checks matched by `CHECK` constraints |
| Messages | At most 32000 characters and 10 files |
| Ids | ULID pattern on every id parameter; share ids `^[A-Za-z0-9_-]{22}$` |
| Cursors | Opaque base64url JSON, length-capped and validated (`INVALID_CURSOR`) |
| Search text | Bound parameters only; `ILIKE` wildcards escaped; full-text queries through `websearch_to_tsquery` |
| URLs the model opens | `checkUrlShape`: http(s) on default ports, no credentials, no internal host names; then every resolved address must be public ([`apps/api/src/domain/net-guard.ts`](../../apps/api/src/domain/net-guard.ts)) |
| Display names | Cleaned at write time: never an email address or phone number |
| Model output | Rendered as Markdown without raw HTML; links `noopener noreferrer nofollow` |

## 7. Files

- Declared type on an allowlist per purpose, extension matching the type, size within
  min(kind ceiling, tier limit); SVG, HTML, XML and scripts refused as declared types;
  executable extensions refused.
- After upload: stored size must equal the declared size and the first bytes must match
  the type's magic number, on what actually landed in storage.
- Images re-encoded (EXIF, GPS and trailing data dropped); documents read by libraries
  that do not execute content; text formats served as `text/plain`.
- Storage keys made by the server and never accepted from or returned to a client; reads
  are short-lived signed URLs; the bucket is private.
- Details: [files.md](files.md).

## 8. Shares

- A share is a frozen snapshot of the branch on screen: later messages never appear
  ([ADR 0010](adr/0010-frozen-share-snapshots.md)).
- Ids are 128 random bits (`crypto.randomBytes(16)`, base64url), not guessable or
  enumerable.
- Images are served through `/api/shared/:id/images/:fileId`, which only knows the file ids
  frozen into that snapshot, as a redirect to a signed URL valid 15 minutes. No storage key
  or long-lived URL is in the snapshot; non-image attachments appear by name only.
- A link dies at once when revoked (owner or admin), expired, when sharing is turned off,
  or when its owner is banned or erased. Public reads are rate limited by IP.

## 9. Privacy

- **No conversation text in logs or usage records.** The logger redacts `content`,
  `prompt`, `messages` and `input` (plus passwords, tokens, codes, keys, cookies) at up to
  three levels deep ([`apps/api/src/core/logger.ts`](../../apps/api/src/core/logger.ts),
  [ADR 0012](adr/0012-no-conversation-text-in-logs.md)); `usage_daily` holds counts and
  model ids only.
- **Tool trace** stores labels, not tool inputs or outputs.
- **Memory** is visible and editable by the user, can be switched off, and is capped.
- **Export**: `GET /api/users/me/export` (3 a day).
- **Deletion**: the user requests it with their password (and second factor); the account
  is erased after 14 days unless they sign in again. Erasure anonymises identity, revokes
  sessions and deletes conversations, projects, memories, images, shares and preferences;
  file objects are removed by the expiry job.
- **Retention**: `retentionDays` (7 to 3650) deletes conversations untouched for longer.
- **Audio** is never stored.

### Push notifications

| Control | Where | Detail |
| --- | --- | --- |
| Opt-in per answer | [`apps/api/src/services/push.service.ts`](../../apps/api/src/services/push.service.ts) | Nothing is pushed unless the app arms one answer with `POST /api/turns/:id/notify`; the web app never does. Arming is owner-checked (`findOwnedMessage`): another account's turn is `404 TURN_NOT_FOUND` ([ADR 0015](adr/0015-push-opt-in-per-answer.md)) |
| Generic text by default | same | The notification says only that the answer is ready. `PUSH_PREVIEW=true` adds the chat title and 120 characters of the answer, which then pass through Google and Apple and show on a locked screen |
| Device tokens | [`apps/api/src/repositories/push-device.repository.ts`](../../apps/api/src/repositories/push-device.repository.ts) | Never returned (`PushDevice` has no token) and never logged (failures log the device id; `token` is a redacted field). One account per token; deleting someone else's token is a silent 204. Removed on native sign-out with `deviceToken`, when every session ends (sign out everywhere, password change or reset, ban, deletion) and when FCM reports them dead |
| Service account key | [`apps/api/src/core/config.ts`](../../apps/api/src/core/config.ts) | `FCM_SERVICE_ACCOUNT_JSON` is a secret: Secrets Manager on AWS (`<name_prefix>/push`), never logged or returned. It needs only the Firebase Cloud Messaging role. The APNs key stays in the Firebase project |

## 10. Headers and CSP

- API: helmet with `default-src 'none'` and `frame-ancestors 'none'` (it serves JSON only),
  no `X-Powered-By`.
- Web: a per-request CSP with a nonce and `strict-dynamic` for scripts, `frame-src 'none'`,
  `frame-ancestors 'none'`, and `MEDIA_ORIGINS` (the bucket) for images, media and
  `connect-src` ([`apps/web/src/middleware.ts`](../../apps/web/src/middleware.ts)); static
  headers: `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: DENY`, `Permissions-Policy` allowing the microphone on this origin only
  (dictation), `Cross-Origin-Opener-Policy: same-origin`
  ([`apps/web/next.config.ts`](../../apps/web/next.config.ts)).

## 11. Rate limits and quotas

- Redis-backed rate limits per route and per service action, shared by every task, with an
  in-memory fallback during a Redis outage ([LLD.md](LLD.md#7-rate-limits)).
- Daily weighted-token and image allowances per user from tiers and overrides
  ([quotas.md](quotas.md)). The system this was ported from had neither.

## 12. Secrets and the production guard

`assertProductionConfig` ([`apps/api/src/core/config.ts`](../../apps/api/src/core/config.ts))
refuses to boot with `NODE_ENV=production` when any of these holds:

- `JWT_SECRET` or `REFRESH_SECRET` is the committed development default, shorter than 32
  characters, or the two are equal;
- `TOTP_ENCRYPTION_KEY` is the development default;
- `CORS_ORIGINS` is empty, or `APP_WEB_URL` points at localhost;
- `STORAGE=local`, or `STORAGE=s3` without `S3_BUCKET`;
- `MAIL_MODE=outbox`, or no `MAIL_FROM`;
- `JOBS_MODE=inline`;
- `SEARCH_PROVIDER=stub`, `MODERATION_PROVIDER=stub` or `PUSH_PROVIDER=stub`;
- `FETCH_ALLOW_HOSTS` is set;
- `BCRYPT_ROUNDS` below 12.

`productionWarnings` logs, without refusing, a missing provider key, a search or
moderation provider selected without its key, and `PUSH_PROVIDER=fcm` without a valid
service account. On AWS the JWT, refresh and TOTP secrets are
generated by Terraform; provider and search keys and the FCM service account start as `set-me` placeholders that count
as unset ([`infra/terraform/modules/secrets/main.tf`](../../infra/terraform/modules/secrets/main.tf)).

## 13. Logging

pino with redaction (section 9). Request logs carry method, path (signed local file URLs
masked) and the request id; errors are logged with context and returned as
`500 INTERNAL` with the request id only. Provider failures log a masked excerpt.

## 14. Infrastructure controls

| Control | Where |
| --- | --- |
| Private subnets for every task; one ALB with TLS; HTTP redirected | [`modules/network`](../../infra/terraform/modules/network/main.tf), [`modules/edge`](../../infra/terraform/modules/edge/main.tf) |
| CloudFront with WAF (AWS managed common and known-bad-inputs rules) and a secret origin header the ALB requires | [`modules/cdn`](../../infra/terraform/modules/cdn/main.tf) |
| RDS: encrypted with the deployment's KMS key, master password managed by RDS in Secrets Manager, IAM auth | [`modules/database`](../../infra/terraform/modules/database/main.tf) |
| ElastiCache: encryption at rest and in transit (required), AUTH token | [`modules/cache`](../../infra/terraform/modules/cache/main.tf) |
| S3: public access blocked, KMS encryption, CORS for the app origin only | [`modules/storage`](../../infra/terraform/modules/storage/main.tf) |
| Secrets in Secrets Manager, injected by ECS, never in task definitions | [`modules/secrets`](../../infra/terraform/modules/secrets/main.tf) |
| Read-only root filesystem for containers | [`modules/service`](../../infra/terraform/modules/service/main.tf) |
| VPC flow logs, CloudWatch alarms, encrypted logs | [`modules/network`](../../infra/terraform/modules/network/main.tf), [`modules/observability`](../../infra/terraform/modules/observability/main.tf) |

## 15. Supply chain and CI

- `pnpm install --frozen-lockfile`; dependency overrides pin patched versions
  ([`package.json`](../../package.json)).
- The fast `checks` workflow runs lint, typecheck, unit tests, the OpenAPI check and the
  sanitization scan ([`.github/workflows/checks.yml`](../../.github/workflows/checks.yml)).
- The opt-in full pipeline adds integration tests, gitleaks over the full history, CodeQL,
  `pnpm audit`, tflint and checkov ([`.github/workflows-full/`](../../.github/workflows-full/README.md)).
- [`scripts/check-sanitization.sh`](../../scripts/check-sanitization.sh) refuses AWS keys,
  private keys, account and resource ids, provider key shapes, real emails and public IPs.

## Defects of the system this was ported from

| Defect | Fix |
| --- | --- |
| Attachment IDOR: another account's attachment id was served | Owner-scoped reads everywhere; 404 for foreign ids ([files.md](files.md#5-who-may-read-what)) |
| Client-supplied storage keys | Server-made keys; clients reference file ids only |
| SSRF via redirects: the URL was checked once, then redirects were followed anywhere | Per-hop checks with DNS pinning ([ADR 0008](adr/0008-ssrf-guard-per-hop-with-dns-pinning.md)) |
| Tool output spliced into the system prompt | Tool messages, labelled untrusted ([ADR 0007](adr/0007-tool-results-as-tool-messages.md)) |
| No rate limits | Redis rate limits and daily allowances ([quotas.md](quotas.md)) |
| Prompts stored in usage logs | Counts only; content redacted from logs ([ADR 0012](adr/0012-no-conversation-text-in-logs.md)) |
| Live share links exposing storage keys | Frozen snapshots and a share-scoped image redirect ([ADR 0010](adr/0010-frozen-share-snapshots.md)) |
| Plaintext provider keys in the database | Environment and Secrets Manager only ([ADR 0004](adr/0004-providers-behind-one-interface.md)) |
| Raw provider errors shown to users | Stable codes and fixed messages ([providers.md](providers.md#4-failure-classification)) |

## Known limitations

- **Exfiltration through `open_url`.** An injected instruction can make a model open a
  public URL that carries conversation text. Mitigation: turn web search off for sensitive
  use ([threat-model.md](threat-model.md)).
- **No malware scanning** of uploaded documents; they are only parsed for text and served
  to their owner.
- **Moderation fails open** and is off by default.
- **Token limits can be overshot** by the turns already started.
- **Turns are cut by a hard exit on deploy** and failed by the sweep after 15 minutes.
- **Admins are trusted with configuration**: an admin can point a provider's `base_url` at
  any host, change the system prompt addendum, and read usage counts.
- **No SSO** (OIDC or SAML); passwords and TOTP only.
