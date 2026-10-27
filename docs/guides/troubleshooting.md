# Troubleshooting

Symptoms, causes and fixes, grouped by area. Every error body carries a `requestId` (also
the `X-Request-Id` response header) that finds the API log line; turn failures carry a
stable `code` in their `error` event ([../api/streaming.md](../api/streaming.md)).

## Local stack

| Symptom | Cause | Fix |
| --- | --- | --- |
| `port is already allocated` on `make up` | Another process uses 3540, 5036, 5502, 6439, 8056, 1056, 4607, 5129 or 8089 | Move it in `deploy/compose/.env`: `CHAT_WEB_PORT`, `CHAT_API_PORT`, `CHAT_PG_PORT`, `CHAT_REDIS_PORT`, `CHAT_MAILPIT_PORT`, `CHAT_SMTP_PORT`, `CHAT_FLOCI_PORT`, `CHAT_STUB_PORT`, `CHAT_SEARXNG_PORT` ([quickstart-local.md](quickstart-local.md#ports)) |
| `run make env first` | Compose started without the generated secrets | `make env` (or `make up`, which runs it) |
| The `terraform` or `migrate` one-shot fails | Emulator state and its Terraform state out of step, or a stale `.terraform` from running Terraform on the host | `make logs SERVICE=terraform` (or `migrate`); `make down && make up`; delete `infra/terraform/envs/local-floci/.terraform` |
| No email arrives | Locally every mail goes to Mailpit | http://localhost:8056 |
| Sign-in says `EMAIL_NOT_VERIFIED` | `REQUIRE_EMAIL_VERIFICATION=true` (the default) | Open the link in Mailpit, or set `REQUIRE_EMAIL_VERIFICATION=false` in `.env` for local work |
| A change to `.env` has no effect | Compose reads `.env` when it creates containers | `make up` again |

## Models and providers

| Symptom | Cause | Fix |
| --- | --- | --- |
| The model picker is empty, sends answer `503 MODEL_UNAVAILABLE` "No chat model is available" | No usable CHAT model: a fresh production install has an empty catalogue, or no provider has a key | Create providers and models in `/admin/models` ([providers.md](providers.md)); put the key under the provider's slug in `PROVIDER_KEYS` and restart the API and worker. The boot log warns `no model provider key is configured` |
| A model you added is not in the picker | Model or provider disabled, or the provider has no key under its exact slug (`PROVIDER_KEYS` keys are slugs, not names) | Check `keyConfigured` in `/admin/models`; the catalogue is cached 5 s |
| Turns end with `MODEL_UNAVAILABLE` | The provider answered 401 or 403: a wrong, revoked or unfunded key | Press **Test** on the model; the API log has `provider call failed` with the status |
| Turns end with `PROVIDER_ERROR` | A 4xx not about context or safety (often a wrong `modelRef`, or a capability the model lacks, like tools on a model without function calling), a 5xx, a timeout (180 s) or an unreachable host | **Test** says "check the model id" for a bad request; fix `modelRef` or turn off `supportsTools` / `supportsVision`; read the masked excerpt in the log |
| `PROVIDER_RATE_LIMITED` | The provider returned 429 for your key | Raise the limit at the provider, spread users across models, or lower quotas |
| `CONTEXT_TOO_LONG` | The conversation plus attachments exceed what the provider accepts, often because `contextWindow` in the catalogue is larger than the model's real window | Set the real window; start a new chat |
| `400 MODEL_NO_VISION` on send | An image attached to a model without `supportsVision` | Pick a vision model, or mark the model as vision-capable if it is |
| `400 STUB_IN_PRODUCTION` | Creating a `STUB` provider with `NODE_ENV=production` | Use a real provider |
| Ollama in Docker cannot be reached | `localhost` inside the API container is the container | Base URL `http://host.docker.internal:11434/v1` (Docker Desktop) or the host's bridge address |
| Image mode answers `400 IMAGES_UNAVAILABLE` | `features.imageGeneration` off, or no enabled IMAGE model with a usable provider | Add an IMAGE model (OpenAI, Gemini or compatible; Anthropic has none) |
| Dictation or read aloud answer `503 MODEL_UNAVAILABLE` | No TRANSCRIBE or SPEECH model | Add one served through OpenAI-style `/audio/*` endpoints |

## Streaming

| Symptom | Cause | Fix |
| --- | --- | --- |
| The answer appears all at once at the end | Something between the browser and the API buffers the response: a reverse proxy, a CDN with compression, an antivirus or corporate proxy | The API already sends `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`. Turn off buffering and compression for `/api/*` in your proxy ([deploy-aws.md](deploy-aws.md#streaming-through-the-load-balancer)) |
| Behind nginx: buffered or cut streams | nginx buffers proxied responses and closes idle upstreams after `proxy_read_timeout` (60 s) | For `/api/`: `proxy_buffering off; proxy_http_version 1.1; proxy_set_header Connection ""; proxy_read_timeout 300s; gzip off;`. The 15 s keep-alive comments keep the connection busy |
| Streams cut after about 60 s on AWS | An ALB idle timeout left at the default | `alb_idle_timeout` (300 s in the module); check nothing else in front has a shorter timeout |
| The stream drops on a phone or a flaky network | Normal: the turn keeps running on the server | Clients resume with `GET /api/turns/:id/events?after=<seq>`; `followTurn` does it automatically ([mobile-clients.md](mobile-clients.md#streaming-answers)) |
| After a reload the answer area is empty for a moment, then fills | The page rejoined a running turn from the start of its event log | Expected |
| `409 TURN_IN_PROGRESS` on send | An answer is still being written in this chat (possibly in another tab) | Wait, or press Stop (`POST /api/turns/:id/cancel`) |
| A message stays "writing" for minutes, then fails with "Something went wrong" | The API task running the turn died (a deploy, a crash, an OOM). The message stayed `STREAMING` until `maintenance.sweep-turns` failed it (15 minutes after it started, checked every 2 minutes) | Regenerate. If it happens outside deploys, look for task restarts and memory alarms. Make sure a worker runs: the sweep is a scheduled job ([operations.md](operations.md#turns-and-deploys)) |
| `GET /api/turns/:id/events` returns only `message.completed` and `done` | The turn finished more than an hour ago; the event log expired and the stored message is replayed | Expected |

## Files

| Symptom | Cause | Fix |
| --- | --- | --- |
| The upload PUT fails in the browser with a CORS error | The bucket's CORS does not list the web origin, or `MEDIA_ORIGINS` (the web CSP) does not list the bucket | Terraform sets the bucket CORS to the app URL plus `media_cors_extra_origins`; set `MEDIA_ORIGINS` on the web container to the bucket origin (compose sets Floci's) |
| Images or thumbnails do not load, the console shows a CSP violation | `MEDIA_ORIGINS` missing the storage origin | Same as above |
| `400 FILE_SIZE_MISMATCH` or `FILE_TYPE_MISMATCH` on complete | The bytes stored differ from what was declared: a different file, a proxy that recompressed it, a wrong `mimeType` | Upload the original file with its real type |
| `413 FILE_TOO_LARGE` | Above the kind's ceiling (images 20 MB, PDFs 100 MB, documents and spreadsheets 50 MB, text 20 MB) or the user's tier `max_file_mb` (25 MB in the default tier) | Raise the tier's limit in `/admin/quotas` (the kind ceilings are fixed) |
| `400 FILE_TYPE_NOT_ALLOWED` | SVG, HTML, executables and unknown types are refused | Convert, or attach source code as text |
| A HEIC photo is rejected: "HEIC photos cannot be processed on this server" | The image library in the API image could not decode that HEIC | Export the photo as JPEG; mobile apps should convert before upload |
| A PDF is rejected: "No text found: scanned PDFs need to be sent as images" | The PDF has no text layer | Send the pages as images to a vision model, or OCR it first |
| "The document could not be read (it may be encrypted or damaged)" | Password-protected or broken file | Remove the password and retry |
| A file stays PROCESSING | The worker is down (`files.process` runs there) | `make logs SERVICE=worker`; on AWS check the worker service |
| `409 FILE_IN_USE` deleting a file | It was sent in a message | Delete the conversation instead |

## Web search and pages

| Symptom | Cause | Fix |
| --- | --- | --- |
| No web search toggle | `GET /api/meta` reports `features.webSearch: false`: `SEARCH_PROVIDER=none`, a provider without its URL or key (`set-me` counts as missing), or the feature off in settings | Configure a provider ([web-search.md](web-search.md)); the boot log warns which key is missing |
| The model never searches | The model lacks `supportsTools` (it gets one pre-search instead), or the toggle was off for that message | Use a tool-capable model |
| "Search is unavailable right now." in the tool step | The search provider failed or timed out (15 s) | Check SearXNG at http://localhost:8089 or the hosted provider's status; the API log has `provider call failed` |
| `open_url` says "that address cannot be opened" | The URL resolves to a private, loopback or link-local address, uses another port than 80/443, or carries credentials: the SSRF guard ([tools-and-safety.md](../architecture/tools-and-safety.md)) | Expected for internal hosts. Only for local development may `FETCH_ALLOW_HOSTS` list a host |
| `open_url` says "the page answered 403" or "could not be read" | The site refused the bot, is not text (PDF, image), or took more than 12 s | Paste the text instead |

## Quotas and limits

| Symptom | Cause | Fix |
| --- | --- | --- |
| `QUOTA_EXCEEDED`: "You have used today's allowance. It resets at midnight UTC." | The user's weighted tokens for the UTC day reached the limit of their tier or override | `/admin/users` shows usage; move the user to another tier or set an override ([quotas.md](../architecture/quotas.md)). Heavy models count more (`weight`) |
| "Daily image limit reached" | The image allowance is reserved before each generation | Same; a failed generation gives its reservation back |
| `429 RATE_LIMITED` with `Retry-After` | Per-user or per-IP rate limits: 30 sends a minute, 10 studio images a minute, 20 dictations a minute, sign-in budgets | Wait. Behind a proxy, check `TRUST_PROXY`, or every user shares one IP |

## Accounts and sign-in

| Symptom | Cause | Fix |
| --- | --- | --- |
| `403 REGISTRATION_CLOSED` or `REGISTRATION_DOMAIN_NOT_ALLOWED` | `registration` is `CLOSED`, or `INVITE_ONLY` and the address is not at an allowed domain | `/admin/settings` |
| Signed out after every reload | The refresh cookie is not stored: the web app and the API on different sites, or `COOKIE_SECURE=true` on plain http | Serve the app and `/api` on one origin; `COOKIE_SECURE=auto` |
| `403 CORS_ORIGIN_DENIED` | A non-GET request from an origin not in `CORS_ORIGINS` | Add the origin |
| `403 ACCOUNT_RESTRICTED` on send | The account is suspended (read-only until it ends) | `/admin/users` |
| `409 LAST_ADMIN` | The last active admin tried to delete or demote themselves | Promote someone else first |
| Locked out of the only admin account | | `make admin EMAIL=you@example.com` locally, `make aws-admin ENV=... EMAIL=...` on AWS: promotes the account, or creates it and emails a set-password link |

## Boot and deployment

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Refusing to start with an insecure configuration:` and a list | `NODE_ENV=production` with a development secret, `STORAGE=local`, `MAIL_MODE=outbox`, `JOBS_MODE=inline`, a stub search or moderation, `FETCH_ALLOW_HOSTS`, no `CORS_ORIGINS`, a localhost `APP_WEB_URL`, `BCRYPT_ROUNDS` below 12 | Fix each line ([configuration.md](configuration.md#production-guard)) |
| `Invalid configuration:` | A value fails the schema (a non-URL `APP_WEB_URL`, a `TOTP_ENCRYPTION_KEY` that is not 32 bytes base64, an unknown enum value) | The message names the variable |
| Tasks die at start with `exec format error` | Images built for another CPU than `cpu_architecture` | `PLATFORM=linux/arm64` for `ARM64`, `linux/amd64` for `X86_64` ([deploy-aws.md](deploy-aws.md#deploy)) |
| `make aws-admin` exits non-zero: "The set-password email could not be sent" | SES identity unverified or still in the sandbox | Verify the domain and the recipient, or request production access |
| The migrate task fails with a checksum error | An applied migration file was edited | Restore the file; add a new migration instead |
| `/api/ready` answers 503 | Postgres or Redis unreachable | Check security groups, the database secret, ElastiCache status |
