# Configuration reference

Every environment variable the API, the worker and the web app read, with its default and
purpose; the deployment settings edited in `/admin/settings`; and how the local compose
stack and Terraform set them.

The API and worker read one schema, [`apps/api/src/core/config.ts`](../../apps/api/src/core/config.ts),
validated with zod at boot (`Invalid configuration: ...` lists every bad value). Booleans
accept `true`, `false`, `1`, `0` or empty. Outside production the security-critical values
fall back to development defaults so `make up` works with no setup; with
`NODE_ENV=production` the [production guard](#production-guard) refuses to boot while any
of them is still a default.

A key value of `set-me` (the Terraform placeholder) or an empty string counts as **not
configured** for every provider and search key (`isRealKey` in `config.ts`). That is what
lets Terraform create the secrets before you have the keys.

## API and worker

### Runtime and HTTP

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production`. Production turns the guard's problems into a boot failure |
| `PORT` | `5036` | API listen port |
| `PRODUCT_NAME` | `Euron Open AI Chat` | The default `appName` setting and the name used in emails until an admin sets one |
| `APP_WEB_URL` | `http://localhost:3540` | The web app's public origin: emailed links, share URLs (`/share/<id>`), the CORS default. Production refuses `localhost` |
| `PUBLIC_API_URL` | `http://localhost:5036` | The API's public origin: signed local-storage file URLs (`STORAGE=local`) and the image URLs inside a shared conversation |
| `CORS_ORIGINS` | empty (then `APP_WEB_URL`) | Comma-separated origins allowed with credentials; a non-GET request with another `Origin` gets `403 CORS_ORIGIN_DENIED`. Required in production |
| `TRUST_PROXY` | `1` | Express `trust proxy` hop count (1 behind the ALB, 2 behind CloudFront and the ALB), so `req.ip` is the client for rate limits and the audit log |
| `LOG_LEVEL` | `info` | pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Under `NODE_ENV=test` the default `info` becomes `silent` |

`TZ` is not configuration: `index.ts`, `worker.ts` and `cli.ts` set `process.env.TZ = "UTC"`
before anything else loads.

### Database

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | unset | A `postgres://` URL. Local, CI and compose |
| `DATABASE_SECRET_ARN` | unset | AWS: the RDS-managed master secret (or the app role's secret); the password is fetched from Secrets Manager and cached, so a rotation is picked up by new connections ([`db/connection-config.ts`](../../apps/api/src/db/connection-config.ts)) |
| `DB_HOST` | unset | Host when using `DATABASE_SECRET_ARN` |
| `DB_PORT` | `5432` | Port when using `DATABASE_SECRET_ARN` |
| `DB_NAME` | unset | Database name when using `DATABASE_SECRET_ARN` |
| `DB_USER` | unset | User name override when using `DATABASE_SECRET_ARN` |
| `DB_SSL` | unset | `disable`, `require` or `verify-full` |
| `DB_SSL_CA_FILE` | unset | CA bundle file for `verify-full`. Terraform uses `require` |
| `DB_POOL_MAX` | `10` | Connections per process. Each API and worker task has its own pool |
| `MIGRATE_ON_BOOT` | `false` | Apply pending migrations when the API starts. Compose and AWS run a separate one-shot `migrate` instead |
| `MIGRATIONS_DIR` | `db/migrations` next to the runner | Read only by [`db/migrate.ts`](../../db/migrate.ts) |

### Redis and jobs

| Variable | Default | Purpose |
| --- | --- | --- |
| `REDIS_URL` | `redis://localhost:6439` | BullMQ, rate limits, quota counters, the turn event log and cancellation ([streaming-and-resume.md](../architecture/streaming-and-resume.md)) |
| `JOBS_MODE` | `queue` | `queue`: BullMQ, handlers run in the worker. `inline`: handlers run in the API process after commit (tests, tiny installs; no schedules). Production refuses `inline` |

### Sessions, passwords and limits

| Variable | Default | Purpose |
| --- | --- | --- |
| `JWT_SECRET` | a committed development value | Signs access tokens. Production: 32+ characters, not the default |
| `REFRESH_SECRET` | a committed development value | Production: 32+ characters and different from `JWT_SECRET` |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token lifetime (cookie, or body in native mode) |
| `COOKIE_SECURE` | `auto` | `auto` sets `Secure` on the `chat_refresh` cookie when `APP_WEB_URL` is https; `true` or `false` force it |
| `BCRYPT_ROUNDS` | `12` | bcrypt cost, 4 to 15. Production refuses less than 12 (the test suite uses 4) |
| `REQUIRE_EMAIL_VERIFICATION` | `true` | Sign-up answers 202 and the account stays `PENDING_VERIFICATION` until the emailed link is used |
| `TOTP_ENCRYPTION_KEY` | derived from a public constant | 32 bytes, base64 (`openssl rand -base64 32`). Encrypts TOTP secrets at rest and keys the recovery-code HMAC. Required in production |
| `RATE_LIMITS` | on (off under `NODE_ENV=test`) | `off` disables every rate limit. Read live, so a test can switch limits on for one case |
| `RATE_LIMIT_STORE` | Redis (memory under `NODE_ENV=test`) | Under `NODE_ENV=test`, `redis` makes limits use Redis. Read live |

### Storage

| Variable | Default | Purpose |
| --- | --- | --- |
| `STORAGE` | `local` | `local`: files on disk, presigned URLs replaced by HMAC-signed `/api/files/local/<token>` links. `s3`: a private bucket. Production refuses `local` |
| `DATA_DIR` | `data` under the working directory | Where `STORAGE=local` keeps files (and the mail outbox) |
| `S3_BUCKET` | unset | The private bucket. Required with `STORAGE=s3` |
| `S3_REGION` | unset (then `AWS_REGION`) | The bucket's region |
| `S3_PUBLIC_ENDPOINT` | unset | A browser-reachable endpoint for presigned URLs (the Floci emulator locally, `http://localhost:4607`) |
| `AWS_REGION` | `us-east-1` | Default region for the AWS clients |
| `AWS_ENDPOINT_URL` | unset | Points every AWS client at an emulator (`http://floci:4566` in compose) |
| `SIGNED_URL_TTL_SECONDS` | `900` | Lifetime of signed read URLs. Upload URLs live 600 s |

### Mail

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAIL_MODE` | `outbox` | `outbox`: `.eml` files under `DATA_DIR` (and in memory for tests). `smtp` or `ses`. Production refuses `outbox` |
| `MAIL_FROM` | unset | Sender, for example `Euron Open AI Chat <no-reply@chat.example.com>`. Required unless `outbox` |
| `SMTP_HOST` | unset | SMTP server (`mailpit` in compose) |
| `SMTP_PORT` | `587` | SMTP port (compose uses Mailpit's 1025) |
| `SMTP_USER` | unset | SMTP user |
| `SMTP_PASS` | unset | SMTP password |
| `SES_REGION` | unset (then `AWS_REGION`) | SES v2 region |
| `SES_CONFIGURATION_SET` | unset | SES configuration set (bounce and complaint events) |

### Model providers

Keys are configuration, never data: they are read from the environment on every call and
never enter the database, a log line or an API response
([ADR 0004](../architecture/adr/0004-providers-behind-one-interface.md),
[providers.md](providers.md)).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROVIDER_KEYS` | unset | One JSON object keyed by provider slug (the `providers.id` you create in `/admin/models`): `{"openai":"<openai-key>","anthropic":"<anthropic-key>","openrouter":"<openrouter-key>"}`. Wins over the shortcuts below. A malformed value is ignored without echoing it. On AWS it is the whole `<name_prefix>/provider-keys` secret |
| `OPENAI_API_KEY` | unset | Shortcut for slug `openai`. Also used by `MODERATION_PROVIDER=openai` |
| `ANTHROPIC_API_KEY` | unset | Shortcut for slug `anthropic` |
| `GEMINI_API_KEY` | unset | Shortcut for slug `gemini` |
| `OPENROUTER_API_KEY` | unset | Shortcut for slug `openrouter` |
| `GROQ_API_KEY` | unset | Shortcut for slug `groq` |
| `STUBS_URL` | `http://localhost:5129` | Where providers of kind `STUB` live ([`apps/stubs`](../../apps/stubs/server.mjs)); also the stub search and stub moderation |

A provider with no key is simply not offered, except kinds that need none: `STUB` and
`OPENAI_COMPATIBLE` (a local Ollama or vLLM) ([`services/models.service.ts`](../../apps/api/src/services/models.service.ts)).

### Web search, page reading and moderation

| Variable | Default | Purpose |
| --- | --- | --- |
| `SEARCH_PROVIDER` | `none` (compose: `searxng`) | `searxng`, `tavily`, `exa`, `brave`, `stub` or `none`. Production refuses `stub` ([web-search.md](web-search.md)) |
| `SEARXNG_URL` | unset | Base URL of a SearXNG with the JSON format enabled (`http://searxng:8080` in compose) |
| `TAVILY_API_KEY` | unset | For `SEARCH_PROVIDER=tavily` |
| `EXA_API_KEY` | unset | For `SEARCH_PROVIDER=exa` |
| `BRAVE_API_KEY` | unset | For `SEARCH_PROVIDER=brave` |
| `FETCH_ALLOW_HOSTS` | empty | Hosts the `open_url` tool may reach even though they resolve to a private address. Compose sets `stubs`, the tests `127.0.0.1`. Production refuses any value ([tools-and-safety.md](../architecture/tools-and-safety.md)) |
| `MODERATION_PROVIDER` | `none` | `none`, `openai` (the moderation endpoint, needs an `openai` key) or `stub` (flags input containing `STUB_FLAG`). Fails open on an outage. Production refuses `stub` |

### Demo seed

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEMO_PASSWORD` | random, printed | `demo:seed` only: the password of every demo account. `make demo` passes `CHAT_DEMO_PASSWORD` from `deploy/compose/.env` |

### Production guard

`assertProductionConfig` runs at every boot of the API and the worker. Outside production
each problem is a warning line (`config: ...`); with `NODE_ENV=production` the process
refuses to start and lists them all:

| Refused | Why |
| --- | --- |
| `JWT_SECRET` or `REFRESH_SECRET` still the development default, or shorter than 32 characters | Forgeable tokens |
| `JWT_SECRET` equal to `REFRESH_SECRET` | They rotate independently |
| `TOTP_ENCRYPTION_KEY` not set | The default is derived from a public constant |
| `CORS_ORIGINS` empty | Credentialed cross-origin calls must be explicit |
| `APP_WEB_URL` on `localhost` or `127.0.0.1` | Broken links in every email and share |
| `STORAGE=local`, or `STORAGE=s3` without `S3_BUCKET` | Files on a container disk vanish with the task |
| `MAIL_MODE=outbox`, or no `MAIL_FROM` | Mail would never leave |
| `JOBS_MODE=inline` | Background work on the request path, no schedules |
| `SEARCH_PROVIDER=stub`, `MODERATION_PROVIDER=stub` | Test doubles |
| `FETCH_ALLOW_HOSTS` set | Lets `open_url` reach private addresses |
| `BCRYPT_ROUNDS` below 12 | Weak password hashes |

`productionWarnings` lists what must not stop a deployment (an admin has to be able to sign
in and fix it): no provider key at all, a search provider without its URL or key, and
`MODERATION_PROVIDER=openai` without an `openai` key. The admin's Settings page also shows
`GET /api/admin/integrations` (search, moderation, speech, mail and storage mode, never a
key).

## Web app

The web container is a Next.js standalone server
([`apps/web`](../../apps/web/next.config.ts)). It does not read `config.ts`; these are its
own variables:

| Variable | Read by | Purpose |
| --- | --- | --- |
| `API_INTERNAL_URL` | [`next.config.ts`](../../apps/web/next.config.ts), server components | Where the Next server proxies `/api/*` and fetches server-side data (`http://api:5036` in compose). Also a build argument of the web image. On AWS the load balancer routes `/api/*` to the API before Next sees it |
| `PRODUCT_NAME` | [`lib/runtime-env.ts`](../../apps/web/src/lib/runtime-env.ts) | The product name in the header, titles and copy, served at request time by `/env.js` |
| `PUBLIC_API_URL` | same | The API base the browser uses. Default `/api` (same origin), which is what every shipped setup uses |
| `NEXT_PUBLIC_PRODUCT_NAME`, `NEXT_PUBLIC_API_URL` | same | Build-time fallbacks for `next dev`; the runtime values above win |
| `MEDIA_ORIGINS` | [`middleware.ts`](../../apps/web/src/middleware.ts) | Comma-separated origins added to the CSP `img-src`, `media-src` and `connect-src`: where uploads go and signed file URLs point (the S3 bucket, or Floci at `http://localhost:4607`) |

## Local compose variables

[`scripts/gen-local-env.sh`](../../scripts/gen-local-env.sh) (run by `make env` and
`make up`) writes `deploy/compose/.env` with random, local-only values and never overwrites
one. The compose files map them onto the API variables above.

| Variable | Default | Becomes |
| --- | --- | --- |
| `CHAT_JWT_SECRET`, `CHAT_REFRESH_SECRET` | random, 64 characters | `JWT_SECRET`, `REFRESH_SECRET` |
| `CHAT_TOTP_ENCRYPTION_KEY` | 32 random bytes, base64 | `TOTP_ENCRYPTION_KEY` |
| `CHAT_DEMO_PASSWORD` | `Demo-<random>` | `DEMO_PASSWORD` for `make demo` |
| `CHAT_SEARXNG_SECRET` | random | SearXNG's `server.secret_key` |
| `CHAT_PRODUCT_NAME`, `CHAT_LOG_LEVEL` | `Euron Open AI Chat`, `info` | `PRODUCT_NAME`, `LOG_LEVEL` |
| `CHAT_WEB_PORT` | `3540` | Host port of the web app; also `APP_WEB_URL`, `PUBLIC_API_URL` and `CORS_ORIGINS` |
| `CHAT_API_PORT` | `5036` | Host port of the API (for curl) |
| `CHAT_PG_PORT`, `CHAT_REDIS_PORT` | `5502`, `6439` | Host ports of Postgres and Redis (the integration tests use them) |
| `CHAT_MAILPIT_PORT`, `CHAT_SMTP_PORT` | `8056`, `1056` | Mailpit web UI and SMTP |
| `CHAT_FLOCI_PORT` | `4607` | Floci (S3 and SES); also `S3_PUBLIC_ENDPOINT` and `MEDIA_ORIGINS` |
| `CHAT_STUB_PORT` | `5129` | The stubs |
| `CHAT_SEARXNG_PORT` | `8089` | SearXNG |

Provider and search keys (`PROVIDER_KEYS`, `OPENAI_API_KEY`, ..., `SEARCH_PROVIDER`,
`TAVILY_API_KEY`, ...) can be added to the same `.env` by hand; see the commented examples in
[`deploy/compose/.env.example`](../../deploy/compose/.env.example). `make up-aws` also reads
`deploy/compose/.env.aws` ([`.env.aws.example`](../../deploy/compose/.env.aws.example)).

## Deployment settings (`/admin/settings`)

One JSON document in the `settings` table (`key = 'app'`), merged over the defaults in
[`services/settings.service.ts`](../../apps/api/src/services/settings.service.ts), cached
5 seconds per process. `PATCH /api/admin/settings` takes any subset (the `features` and
`defaults` groups merge key by key) and writes an audit entry with the before and after of
each changed key. Validation is in [`controllers/admin.controller.ts`](../../apps/api/src/controllers/admin.controller.ts).

| Setting | Default | Validation | Effect |
| --- | --- | --- | --- |
| `appName` | `PRODUCT_NAME` | 1 to 60 characters | Shown in the app, emails and the system prompt ("You are the assistant in ...") |
| `tagline` | `A private AI assistant for your team.` | up to 160 | Sign-in pages, `GET /api/meta` |
| `registration` | `OPEN` | `OPEN`, `INVITE_ONLY`, `CLOSED` | `CLOSED`: sign-up answers `403 REGISTRATION_CLOSED`. `INVITE_ONLY`: only addresses at an allowed domain or its subdomains (`403 REGISTRATION_DOMAIN_NOT_ALLOWED`) |
| `allowedEmailDomains` | `[]` | up to 100 domains, lower case | Required (at least one) when `registration` is `INVITE_ONLY`, else `400 SETTINGS_INVALID` |
| `supportEmail` | `null` | an email, up to 200, or null | Shown to users and in `GET /api/meta` |
| `systemPromptAddendum` | empty | up to 4000 characters | Appended to the base system prompt as "Operator guidance for this deployment" ([chat-engine.md](../architecture/chat-engine.md)) |
| `features.webSearch` | `true` | boolean | Offers `web_search` and `open_url`; effective only when a search provider is configured |
| `features.imageGeneration` | `true` | boolean | Image mode, the image studio and `generate_image`; effective only with an enabled IMAGE model |
| `features.dictation` | `true` | boolean | `POST /api/speech/transcribe`; needs a TRANSCRIBE model |
| `features.readAloud` | `true` | boolean | `GET /api/messages/:id/speech`; needs a SPEECH model |
| `features.memory` | `true` | boolean | Memories in the prompt and the `remember` tool (each user can still turn memory off) |
| `features.projects` | `true` | boolean | Project instructions and knowledge files reach the model |
| `features.sharing` | `true` | boolean | Creating shares; turning it off also makes every existing link answer 404 |
| `defaults.answerStyle` | `BALANCED` | `CONCISE`, `BALANCED`, `DETAILED` | The deployment default answer style |
| `retentionDays` | `null` (keep forever) | 7 to 3650, or null | `maintenance.retention` deletes conversations untouched for longer ([operations.md](operations.md#retention)) |
| `minSupportedVersion` | `null` | `x.y.z` or null | Published in `GET /api/meta`; mobile apps below it show a forced update screen ([mobile-clients.md](mobile-clients.md)) |

`GET /api/meta` reports each feature as on only when the setting is on **and** the server can
serve it (a search provider, an IMAGE, TRANSCRIBE or SPEECH model), so clients hide what
cannot work ([`services/meta.service.ts`](../../apps/api/src/services/meta.service.ts)).

Quota tiers and per-user overrides are not settings; they have their own tables and pages
([quotas.md](../architecture/quotas.md)).

## How Terraform sets them

[`infra/terraform/modules/deployment/main.tf`](../../infra/terraform/modules/deployment/main.tf)
composes the task environment: `NODE_ENV=production`, `APP_WEB_URL` and `CORS_ORIGINS` from
`domain`, `TRUST_PROXY` 1 or 2 (with the CDN), `STORAGE=s3`, `MAIL_MODE=ses`,
`DATABASE_SECRET_ARN` and the `DB_*` values, and the search and moderation choices from
`terraform.tfvars`. Secrets are injected by ECS from Secrets Manager: `JWT_SECRET` and
`REFRESH_SECRET` (`<name_prefix>/app`), `TOTP_ENCRYPTION_KEY` (`<name_prefix>/totp`),
`PROVIDER_KEYS` (`<name_prefix>/provider-keys`), `REDIS_URL` (the cache module's secret) and,
with a hosted search provider, `TAVILY_API_KEY`, `EXA_API_KEY`, `BRAVE_API_KEY`
(`<name_prefix>/search`). `api_extra_environment` and `api_extra_secrets` add anything else.
See [deploy-aws.md](deploy-aws.md).
