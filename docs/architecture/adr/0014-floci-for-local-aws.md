# ADR 0014: Floci as the local AWS

## Status

Accepted.

## Context

Production uses S3 (presigned PUTs, SSE-KMS, CORS), SES v2, KMS and Secrets Manager.
Mocks in code drift from the real APIs; a real account costs money and needs credentials
for every contributor. The Terraform modules should be exercised before they reach an
account, and the upload flow (presign, PUT from the browser, HEAD and magic-byte check)
only proves itself against something that behaves like S3.

## Decision

- `make up` starts Floci (an open-source AWS emulator, image `floci/floci:2.3.0`) on host
  port 4607, and a one-shot `terraform` container applies
  [`infra/terraform/envs/local-floci`](../../../infra/terraform/envs/local-floci/main.tf)
  against it with the same `kms`, `storage`, `secrets` and `email` modules production uses
  ([`deploy/compose/compose.floci.yaml`](../../../deploy/compose/compose.floci.yaml)).
- The API and worker run with `STORAGE=s3`, `MAIL_MODE=ses` and `AWS_ENDPOINT_URL`
  pointing at the emulator; presigned URLs use `S3_PUBLIC_ENDPOINT=http://localhost:4607`
  so the browser can reach them, and the web app's CSP allows that origin
  (`MEDIA_ORIGINS`). Floci relays SES mail to Mailpit (UI on 8056).
- Redis stays a plain container: Floci serves ElastiCache data only with Docker socket
  access, which the stack does not grant.
- Model providers, search, moderation, images and speech are not AWS; they run against
  `apps/stubs` locally ([`apps/stubs/server.mjs`](../../../apps/stubs/server.mjs)) and the
  bundled SearXNG ([quickstart-local.md](../../guides/quickstart-local.md)).
- The integration matrix runs the suite under every storage and mail backend, including
  `STORAGE=s3` and `MAIL_MODE=ses` against the emulator
  ([`scripts/test-matrix.sh`](../../../scripts/test-matrix.sh)).
- `make up-aws` is the escape hatch: local containers with real S3 and SES.

## Consequences

Positive:

- SDK calls, presigning, CORS and SES run for real, offline, with no AWS account.
- The Terraform modules are applied on every local start.

Trade-offs:

- Emulator fidelity limits: the TLS-only bucket policy is off locally (`enforce_tls =
  false`), IAM is not enforced.
- Emulator state lives in volumes; `make down` resets it with the database.
- One more image to keep pinned.

## Alternatives considered

- **Code-level mocks.** Fast, but they do not test presigning or CORS.
- **A real development account.** Accurate and costly; kept as `make up-aws`.
- **LocalStack.** Comparable; Floci is the emulator the sibling repository
  euron-open-lms already uses, so one setup serves both.
