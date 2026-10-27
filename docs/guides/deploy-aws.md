# Deploy to AWS

Deploy Euron Open AI Chat to your own AWS account with the Terraform in
[`infra/terraform`](../../infra/terraform) and one script. The result is one host name
(`https://<domain>`) serving the web app and `/api/*`, with ECS Fargate services in private
subnets, RDS PostgreSQL, ElastiCache Redis, a private S3 bucket, SES, Secrets Manager and a
customer-managed KMS key. The system view is in [HLD.md](../architecture/HLD.md).

## What gets created

The composition is one module, [`modules/deployment`](../../infra/terraform/modules/deployment/main.tf);
the environments [`envs/aws-dev`](../../infra/terraform/envs/aws-dev/main.tf) and
[`envs/aws-prod`](../../infra/terraform/envs/aws-prod/main.tf) only pick sizes and safety
switches.

| Path | Service | Role |
| --- | --- | --- |
| `https://<domain>/api/*`, `/up` | api | The JSON API; chat turns stream from it as Server-Sent Events |
| `https://<domain>/*` | web | Next.js: the chat app and `/admin` |
| no inbound traffic | worker | BullMQ jobs: file processing, the rolling summary, upkeep |
| one-off | migrate, admin | Task definitions on the api image: apply migrations; create the first administrator |

| | aws-dev | aws-prod |
| --- | --- | --- |
| Availability zones, NAT | 2, one shared NAT | 3, one NAT per AZ, interface endpoints |
| RDS PostgreSQL | single AZ, 3 days of backups, no deletion protection | Multi-AZ, 14 days, deletion protection |
| ElastiCache Redis | 1 node, 1 day of snapshots | 2 nodes with failover, 7 days |
| Tasks (min to max) | api 1 to 2, worker 1, web 1 to 2 | api 2 to 10, worker 2 to 6, web 2 to 6 |
| CloudFront + WAF | off by default (`enable_cdn = false`) | on by default |
| KMS deletion window, secret recovery window | 7 days, 0 | 30 days, 30 days |
| Log retention | 14 days | 365 days |

Services scale on CPU (target 60%) and roll out with the ECS deployment circuit breaker and
automatic rollback.

## Prerequisites

- An AWS account and credentials for it (a profile with administrator rights for the first
  apply).
- `terraform` (1.16), `docker` with buildx, the AWS CLI and `python3`.
- A domain. With a Route 53 hosted zone (`route53_zone_id`) the certificate and DNS records
  are created for you; otherwise pass `certificate_arn` for an ACM certificate you made and
  point your DNS at the load balancer (`terraform output load_balancer_dns_name`).
- A sending domain for SES (`mail_domain`, defaults to `domain`). New SES accounts are in the
  sandbox: verify the recipient addresses or request production access.

## Configure

```bash
cp infra/terraform/envs/aws-dev/terraform.tfvars.example infra/terraform/envs/aws-dev/terraform.tfvars
cp infra/terraform/envs/aws-dev/backend.tf.example infra/terraform/envs/aws-dev/backend.tf   # remote state (recommended)
```

The essentials ([`terraform.tfvars.example`](../../infra/terraform/envs/aws-dev/terraform.tfvars.example)):

| Variable | Purpose |
| --- | --- |
| `region`, `name_prefix` | Where, and the prefix of every name (the media bucket derives from it: make it globally unique) |
| `domain`, `route53_zone_id` or `certificate_arn` | The one public host |
| `mail_domain` | SES sending domain |
| `alarm_email` | Who receives the CloudWatch alarms |
| `enable_cdn` | CloudFront and WAF in front of the load balancer (needs `route53_zone_id`) |
| `provider_keys` | Optional. Leave unset to keep keys out of Terraform state and fill the secret by hand |
| `search_provider`, `searxng_url` | `none` (default), `searxng`, `tavily`, `exa` or `brave` ([web-search.md](web-search.md)) |
| `moderation_provider` | `none` (default) or `openai` |
| `cpu_architecture` | `X86_64` (default) or `ARM64` (Graviton) |
| `db_instance_class`, `cache_node_type` | `db.t4g.small`, `cache.t4g.small` by default |
| `require_email_verification`, `log_level`, `product_name` | Passed to the API |
| `api_extra_environment`, `api_extra_secrets` | Anything else the API should read (names from [configuration.md](configuration.md)) |
| `media_cors_extra_origins` | Extra browser origins for direct uploads (for example `http://localhost:3540` with `make up-aws`) |

## Deploy

```bash
make aws-deploy ENV=aws-dev
```

[`scripts/aws-deploy.sh`](../../scripts/aws-deploy.sh) tags images with the current commit
(`TAG`, override it to pin a release) and runs:

1. `terraform apply` of the image registries (and the KMS key that encrypts them);
2. `docker buildx build --push` of the api and web images for `PLATFORM`, which must match
   `cpu_architecture` (`linux/amd64` for `X86_64`, `linux/arm64` for `ARM64`; a mismatch
   builds fine and then dies with `exec format error`);
3. `terraform apply` of what the migrate task needs (network, database, task definition);
4. the migrate task, waited for ([`scripts/aws-run-task.sh`](../../scripts/aws-run-task.sh));
   it must exit 0;
5. `terraform apply` of everything else: cache, edge, the api, worker and web services;
6. `aws ecs wait services-stable`.

It ends by printing the app URL and the secrets that still hold `set-me` placeholders.

Plan without applying: `make aws-plan ENV=aws-dev`. Run migrations alone:
`make aws-migrate ENV=aws-dev`.

## Secrets

Everything secret lives in Secrets Manager, encrypted with the deployment's KMS key, and is
injected by ECS as environment variables; nothing secret is in a task definition or a log
([`modules/secrets`](../../infra/terraform/modules/secrets/main.tf)).

| Secret | Holds | Created with |
| --- | --- | --- |
| `<name_prefix>/app` | `JWT_SECRET`, `REFRESH_SECRET` | 64 random characters each, distinct |
| `<name_prefix>/totp` | `TOTP_ENCRYPTION_KEY` | 32 random bytes, base64. Not rotated with the signing keys: rotating it invalidates every enrolled authenticator |
| `<name_prefix>/provider-keys` | `PROVIDER_KEYS`: one JSON object keyed by provider slug | `set-me` per slug unless `provider_keys` was passed |
| `<name_prefix>/search` | `TAVILY_API_KEY`, `EXA_API_KEY`, `BRAVE_API_KEY` | Only with a hosted `search_provider`; `set-me` placeholders |
| the cache module's secret | `REDIS_URL` with its AUTH token, TLS | Generated |
| the RDS-managed secret | The database master password | RDS (rotated by RDS; the API reads it per connection through `DATABASE_SECRET_ARN`) |

Terraform never overwrites a secret value after creation (`ignore_changes` on the string), so
values you put in by hand stay.

### Provider and search keys

Chats cannot be answered until at least one provider key is real:

```bash
aws secretsmanager put-secret-value --secret-id <name_prefix>/provider-keys \
  --secret-string '{"openai":"<openai-key>","anthropic":"<anthropic-key>"}'
```

The slug names must match the providers you create in `/admin/models`
([providers.md](providers.md)). With a hosted search provider:

```bash
aws secretsmanager put-secret-value --secret-id <name_prefix>/search --secret-string \
  '{"TAVILY_API_KEY":"<tavily-key>","EXA_API_KEY":"set-me","BRAVE_API_KEY":"set-me"}'
```

Then roll the API and worker so they read the new values: run `make aws-deploy` again, or

```bash
aws ecs update-service --cluster <cluster> --service <api service> --force-new-deployment
aws ecs update-service --cluster <cluster> --service <worker service> --force-new-deployment
```

(`terraform output cluster_name` and `terraform output services` give the names.)

## The first administrator

```bash
make aws-admin ENV=aws-dev EMAIL=you@example.com
```

This runs `node dist/cli.js admin:create --email you@example.com` as a one-off task
([`services/admin-bootstrap.service.ts`](../../apps/api/src/services/admin-bootstrap.service.ts)):
it promotes an existing account without touching its password, or creates the account and
emails a set-password link through SES. It never prints a password (task output goes to
CloudWatch Logs). When the link cannot be emailed it creates nothing and exits non-zero:
verify the SES identity first.

## First-time setup in `/admin`

A production install starts with an empty model catalogue (the starter catalogue is only
added by `make demo`):

1. **Models**: create the providers whose keys you stored (slug, kind, base URL) and their
   models; press **Test** on each ([providers.md](providers.md#admin-steps-adminmodels)).
   Add an IMAGE model for image generation, TRANSCRIBE and SPEECH models for voice.
2. **Quotas**: review the seeded `Default` tier (200,000 weighted tokens and 20 images per
   day, 25 MB files) and create others ([quotas.md](../architecture/quotas.md)).
3. **Settings**: name and tagline, registration (`OPEN`, `INVITE_ONLY` with your email
   domains, or `CLOSED`), support email, the system prompt addendum, features, retention
   ([configuration.md](configuration.md#deployment-settings-adminsettings)).

## Streaming through the load balancer

Chat turns are long Server-Sent Events responses. The deployment is set up so nothing
buffers or cuts them:

- The ALB idle timeout (how long a connection may go without a byte) is raised to **300 s**
  (`alb_idle_timeout`, from the ALB's 60 s default), leaving room for a slow model's first
  token and long tool calls ([`modules/edge/main.tf`](../../infra/terraform/modules/edge/main.tf)).
- The API writes a `: keep-alive` comment every **15 s** on every event stream and sets
  `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`
  ([`middleware/sse.ts`](../../apps/api/src/middleware/sse.ts)).
- The browser reaches `/api/*` through the load balancer straight to the API, never through
  the Next server.
- With CloudFront on, `/api/*` uses the managed `CachingDisabled` policy with compression off,
  so a stream is passed through as it is written ([`modules/cdn/main.tf`](../../infra/terraform/modules/cdn/main.tf)).

If a stream is still cut (another proxy in front, a corporate network), clients resume with
`GET /api/turns/:id/events?after=<seq>` and lose nothing
([streaming-and-resume.md](../architecture/streaming-and-resume.md)).

## CloudFront and WAF

With `enable_cdn = true` CloudFront serves the host, WAF is attached (`enable_waf`), the
load balancer accepts only CloudFront's origin ranges, and both listener rules require a
secret `X-Origin-Verify` header that only this distribution sends; anything else gets 403.
`TRUST_PROXY` becomes 2. `/_next/static/*` is cached; pages and `/api/*` are not.

## Updating

Commit, then `make aws-deploy ENV=aws-prod` again: new images, migrations, then the
services roll. Migrations are forward-only and checksummed; a deploy never edits an
applied one. A bad image is rolled back by the circuit breaker; redeploy a previous tag with
`TAG=<commit> make aws-deploy ENV=...`.

A rolling deploy stops old API tasks with SIGTERM: they stop accepting requests and finish
in-flight ones (forced after 25 s). A turn still running on a stopped task is failed by
`maintenance.sweep-turns` ([operations.md](operations.md#turns-and-deploys)).

## Using real AWS from your laptop

`make up-aws` runs the local stack against real AWS resources (an `aws-dev` bucket and SES
configuration set) with your AWS profile: copy
[`deploy/compose/.env.aws.example`](../../deploy/compose/.env.aws.example) to `.env.aws` and
fill it from `terraform output`. Add `http://localhost:3540` to `media_cors_extra_origins` so
the browser may upload to the bucket.

## Tearing down

`aws-dev` has no deletion protection: `terraform -chdir=infra/terraform/envs/aws-dev destroy`.
`aws-prod` refuses until you turn `deletion_protection` off and empty the bucket. Secrets
have a 30-day recovery window in `aws-prod`.
