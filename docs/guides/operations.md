# Operations

Running a deployment day to day: health, logs, alarms, background jobs and their schedules,
turns across deploys, retention, account deletion, backups, migrations, rotating secrets and
scaling. Names below use `<name_prefix>` from `terraform.tfvars`.

## Health endpoints

| Endpoint | Answers | Used by |
| --- | --- | --- |
| `GET /up` | `{ ok: true }` while the process runs | The container health check |
| `GET /api/ready` | `{ ok: true }` when Postgres and Redis answer, else 503 | The ALB target group health check |
| `GET /` (web) | 200 when Next renders | The web target group |

Neither API endpoint is written to the access log ([`app.ts`](../../apps/api/src/app.ts)).

## Logs

Every service logs pino JSON to CloudWatch Logs, group `/open-chat/<name_prefix>/<service>`
(`api`, `worker`, `web`, and the one-off `migrate` and `admin` tasks). Each API line carries
the request id that error bodies return as `requestId` (and the `X-Request-Id` header), so a
user's report with a request id finds the line.

What is never in a log ([ADR 0012](../architecture/adr/0012-no-conversation-text-in-logs.md),
[`core/logger.ts`](../../apps/api/src/core/logger.ts)): passwords, tokens, one-time codes,
cookies, API keys, and conversation content. Fields named `content`, `prompt`, `messages`
and `input` are redacted up to three levels deep, provider error bodies are cut to 600
characters with key-shaped strings masked, and signed local file links are masked in request
URLs.

Useful CloudWatch Logs Insights queries:

```
fields @timestamp, msg, job, attempts | filter level >= 50 | sort @timestamp desc
fields @timestamp, provider, status, body | filter msg = "provider call failed" | sort @timestamp desc
fields @timestamp, count | filter msg = "stale turns marked failed"
fields @timestamp, msg | filter msg like /moderation unavailable/
```

## Alarms

[`modules/observability`](../../infra/terraform/modules/observability/main.tf) creates
CloudWatch alarms that notify `alarm_email` through SNS:

| Alarm | Fires on |
| --- | --- |
| `<service>-5xx`, `<service>-unhealthy` | 5xx responses from api or web tasks; tasks failing health checks |
| `<service>-cpu`, `<service>-memory` | CPU or memory above 85% |
| `db-cpu`, `db-storage`, `db-connections` | Database CPU above 80%, less than 5 GiB free, connections above 80% of the ceiling |
| `worker-failed-jobs` | Failed job attempts in the worker log above the threshold in 5 minutes |

## Background jobs

Jobs are named handlers with a JSON payload ([`jobs/registry.ts`](../../apps/api/src/jobs/registry.ts)).
The queue is the first segment of the name; BullMQ retries 5 times with exponential backoff
from 5 s.

| Job | Queue (worker concurrency) | Enqueued by | Does |
| --- | --- | --- | --- |
| `files.process` | `files` (4) | `POST /api/files/:id/complete`, after commit | Re-encode an image (EXIF dropped, 2048 px) and write a thumbnail, or extract a document's text and index it; marks the file READY or REJECTED ([files.md](../architecture/files.md)) |
| `chat.summarize` | `chat` (8) | A turn whose context dropped older messages | Fold older turns into the conversation's rolling summary ([chat-engine.md](../architecture/chat-engine.md)) |
| `chat.title` | `chat` (8) | (registered; titles are normally written inline at the end of the first answer) | Write a title for a conversation |
| `maintenance.*` | `maintenance` (2) | The schedules below | Upkeep |

Schedules, registered by every worker on boot (repeatable jobs keyed by name and interval, so
exactly one schedule exists) in [`worker.ts`](../../apps/api/src/worker.ts):

| Job | Every | Does |
| --- | --- | --- |
| `maintenance.sweep-turns` | 2 minutes | Marks messages still `STREAMING` 15 minutes after they were created as `FAILED` (`error_code = INTERNAL`): the task running them died |
| `maintenance.lift-suspensions` | 5 minutes | Timed suspensions that have run out become ACTIVE (also lifted lazily at sign-in) |
| `maintenance.expire-files` | 30 minutes | Deletes abandoned uploads, rejected and deleted files, and files nothing references, from storage and the table |
| `maintenance.purge-accounts` | 6 hours | Erases accounts whose deletion request is older than 14 days, re-checking each under a row lock |
| `maintenance.retention` | 6 hours | Deletes conversations untouched for longer than `retentionDays`, when set |

Every handler is safe to run twice or on two workers at once (conditional updates, row locks).

### `JOBS_MODE`

| | `queue` (default, every deployment) | `inline` (tests, tiny installs) |
| --- | --- | --- |
| Where handlers run | The worker process | The API process, right after commit |
| Retries | 5, exponential backoff | None: an error is logged |
| Schedules | Registered by the worker | None: no sweep, no expiry, no purge, no retention |
| Production | OK | Refused by the production guard |

If the worker is down, uploads stay PROCESSING (the client keeps polling), summaries are not
written (older context is simply dropped), and upkeep waits; chat turns themselves do not
depend on the worker.

## Turns and deploys

A turn (one assistant answer) runs inside the API task that accepted the message, not in the
worker and not tied to the HTTP connection ([ADR 0005](../architecture/adr/0005-turns-decoupled-via-redis-streams.md)).
Redis is the coordination point: events go to the stream `turn:<id>:events` (kept one hour
after the last event) and any API task can serve `GET /api/turns/:id/events`; a cancel on any
task reaches the running one through Redis pub/sub
([streaming-and-resume.md](../architecture/streaming-and-resume.md)).

On SIGTERM (a deploy, a scale-in) an API task stops accepting connections, waits for
in-flight requests and exits, forced after 25 s ([`index.ts`](../../apps/api/src/index.ts)).
Turns still running in that task stop with it. Their partial text was streamed but not
saved; the message stays `STREAMING` until `maintenance.sweep-turns` marks it `FAILED` (at
most about 17 minutes later), and the client following it sees the stream end and shows the
failure. The user regenerates. To keep this rare, deploy outside peak hours; the ALB's
deregistration delay (60 s) lets most answers finish first.

The conversation is never blocked for long: a send while an answer is `STREAMING` answers
`409 TURN_IN_PROGRESS`, which ends when the turn finishes or is swept.

## Retention

`retentionDays` in `/admin/settings` (7 to 3650, or empty to keep forever). Every 6 hours
`maintenance.retention` deletes conversations whose `last_message_at` is older, 500 at a time,
with their messages and file links; files nothing references any more are removed by the next
`maintenance.expire-files`. Each run that deleted something writes a `retention.applied`
audit entry with the count. Generated images stay in the gallery until their owner deletes
them or the account is erased.

## Account deletion and erasure

| Path | What happens |
| --- | --- |
| A user deletes their account (`DELETE /api/users/me`) | Signed out everywhere, `deletion_requested_at` set. Signing in within 14 days cancels it; after that `maintenance.purge-accounts` erases it |
| An admin erases an account (`POST /api/admin/users/:id/erase`, reason required) | Immediate |

Erasure ([`services/account.service.ts`](../../apps/api/src/services/account.service.ts))
anonymises the user row (email, username, name, password, two-factor), revokes sessions,
deletes shares, images, conversations, projects, memories, preferences and the quota
override, and marks files DELETED for the expiry job. `usage_daily` rows stay: they hold
counts only. The last active admin cannot delete themselves (`409 LAST_ADMIN`).

## Audit trail

`audit_log` records every admin action (role, suspend and ban, erase, tier, override,
provider and model changes, settings with before and after, share takedown), account events
(`user.signup`, `user.login`, `user.email_verified`, two-factor changes, recovery code use,
export, deletion requested and cancelled), session events (`session.revoke`,
`session.reuse_detected` for a replayed refresh token), the admin bootstrap, and the jobs
that change accounts or data (`user.suspension_lifted`, `user.purged`, `retention.applied`).
Read it at
`/admin/audit` (`GET /api/admin/audit?action=<prefix>`). Admins cannot read conversations;
the trail is how their actions are accounted for.

## Backups and restore

| Store | Backup |
| --- | --- |
| Postgres (RDS) | Automated snapshots: 3 days in `aws-dev`, 14 days in `aws-prod` (`db_backup_retention_days`), point-in-time restore inside that window |
| S3 (files) | Versioning on; objects are encrypted with the deployment's KMS key |
| Redis | Snapshots (1 day `aws-dev`, 7 days `aws-prod`). Nothing in Redis is the only copy of anything durable: turn logs expire after an hour, quota counters are re-seeded from `usage_daily`, queued jobs are retried |

To restore, create an RDS instance from a snapshot and point the deployment at it (or
restore in place under the same identifier). A file whose row survives but whose object is
gone is served as missing; a restored database may reference objects deleted since, which the
expiry job tidies.

## Migrations

[`db/migrate.ts`](../../db/migrate.ts) applies `db/migrations/*.sql` in order, forward-only,
checksummed, under a Postgres advisory lock, recording each in its own table. Locally it runs
as the compose `migrate` one-shot; on AWS as the migrate task (`make aws-migrate`, and as
step 4 of `make aws-deploy`). Never edit an applied migration: the runner refuses to start
when a checksum changes.

## Rotating secrets

| Secret | How | Effect |
| --- | --- | --- |
| `JWT_SECRET` | Put a new value in `<name_prefix>/app`, roll api and worker | Every access token is invalid; clients refresh silently |
| `REFRESH_SECRET` | Same | Signs out everyone |
| `TOTP_ENCRYPTION_KEY` | Do not rotate casually | Every enrolled authenticator stops working; users would need recovery codes |
| `PROVIDER_KEYS` | Put the new JSON in `<name_prefix>/provider-keys`, roll api and worker | Immediate on new tasks; rotate at the provider after the roll |
| Search keys | `<name_prefix>/search`, roll | Same |
| Database password | RDS rotates the managed secret | New connections read the new password (cached 60 s) |

## Scaling

| Component | How it scales | What makes that safe |
| --- | --- | --- |
| API tasks | Horizontally on CPU (target 60%) | Sessions in Postgres; rate limits, quota counters and turn events in Redis; settings and the model catalogue cached 5 s per process. No stickiness: a client may follow a turn from any task |
| Turns | With the API tasks | Each turn holds one provider connection and one Redis subscription per process (shared by every follower). Streams are I/O bound; scale on connections and CPU, and keep `DB_POOL_MAX` times tasks under the database's connection ceiling |
| Worker tasks | Horizontally | BullMQ locks jobs; handlers are idempotent |
| Web tasks | Horizontally | Stateless |
| Postgres | Vertically, storage autoscaling | Keyset pagination, partial indexes for hot lists, full-text search over `file_chunks` and `messages` with GIN indexes ([ADR 0009](../architecture/adr/0009-postgres-full-text-search.md)) |
| Redis | Vertically; `aws-prod` runs two nodes with failover | Holds queues, limits, counters and one hour of turn events |

Per-user throughput is bounded by rate limits (30 sends a minute, 10 studio images a minute)
and by the daily allowances in the quota tiers ([quotas.md](../architecture/quotas.md)).
Provider rate limits surface to users as `PROVIDER_RATE_LIMITED`.

## Failure modes

| Failure | Effect | Recovery |
| --- | --- | --- |
| Postgres down | `/api/ready` 503, tasks leave rotation | RDS failover (`aws-prod` Multi-AZ) |
| Redis down | `/api/ready` fails; rate limits fall back to per-task memory; turns cannot start or stream; jobs cannot be enqueued | ElastiCache failover in `aws-prod` |
| A provider down or rate limiting | That model's turns end with `PROVIDER_ERROR` or `PROVIDER_RATE_LIMITED`; other providers unaffected | Users pick another model; admins can disable the model |
| Search provider down | `web_search` returns a tool error; the model answers without it | None needed |
| Moderation provider down | Fails open (logged `moderation unavailable; allowing`) | None needed |
| Worker down | Uploads stay PROCESSING, upkeep waits | Jobs run when a worker returns |
| An API task dies mid-turn | The turn stops; the sweep fails it within about 17 minutes | The user regenerates |
| Bad image deployed | Circuit breaker rolls back | Redeploy a previous tag |
