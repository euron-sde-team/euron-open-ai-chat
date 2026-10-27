# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.x (latest minor) | Yes |
| Older minors | No |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository ("Security" tab, "Report a vulnerability"):
https://github.com/euron-sde-team/euron-open-ai-chat/security/advisories/new

Please include:

- the affected component (`apps/api`, `apps/web`, `packages/api-client`,
  `infra/terraform/...`) and version or commit,
- a description of the issue and its impact,
- steps to reproduce, or a proof of concept (against your own deployment or the local
  stack, never someone else's),
- any suggested mitigation.

What to expect:

| Stage | Target |
| ----- | ------ |
| Acknowledgement | within 3 business days |
| Initial assessment and severity | within 7 business days |
| Fix or mitigation for critical / high issues | within 30 days |
| Coordinated public disclosure | after a fix is released, credited to you unless you prefer otherwise |

## Scope

In scope: the code in this repository and the infrastructure it provisions with its
default settings. We are most interested in:

- **Authentication and sessions.** Account takeover, access or refresh token theft or
  reuse, bypassing email verification, two-factor or the invite-only domain allowlist,
  session fixation, password reset flaws, sign-in rate limits that can be sidestepped,
  native token mode weaknesses.
- **Conversation privacy.** Reading another account's conversations, messages, turn event
  streams, memories, projects, images or files; following or cancelling another account's
  turn; an admin endpoint that reveals conversation content.
- **Provider keys.** Any way to make the API return, log or store a model, search or
  moderation provider key, or to surface raw provider error text to a user.
- **Server-side request forgery.** Making `open_url` (or anything else) reach a private,
  loopback, link-local or metadata address, a non-default port, or follow a redirect or a
  DNS answer around the guard.
- **Prompt injection with a concrete impact** beyond changing the answer's text: tool
  results reaching the system prompt, a tool running that the turn did not offer, limits
  on rounds or tool calls that can be exceeded, data leaving through a path other than the
  known `open_url` exfiltration risk described in
  [docs/architecture/threat-model.md](docs/architecture/threat-model.md).
- **Files.** Uploading content types or sizes the API should refuse, magic-byte checks that
  can be bypassed, storage keys accepted from or exposed to a client, presigned URLs that
  grant more than one object or outlive their purpose, stored XSS through file names,
  Markdown or model output, EXIF data surviving re-encoding.
- **Shares.** Reading content that was not frozen into a share, a share outliving its
  revocation, or a share exposing storage keys or other files.
- **Quotas and rate limits.** Spending more than the daily allowance or bypassing a rate
  limit by a margin larger than the documented overshoot.
- **Admin control plane.** Reaching `/api/admin` without the role, changing roles, tiers,
  providers or settings without permission, or tampering with the audit log.

Out of scope:

- **What admins can already do.** Admins manage accounts, quotas, providers (including
  their base URLs) and the system prompt addendum. Reports that rely on that access are out
  of scope; reports that let someone gain it are very much in scope.
- **Content sent to configured providers.** Prompts go to the model, search and moderation
  providers the operator configures, by design.
- **Model behaviour.** A model saying something false or unwanted, or following a
  jailbreak to change its own answer, without one of the concrete impacts listed above.
- **The demo seed.** `make demo` creates well-known demo accounts on purpose and refuses to
  run with `NODE_ENV=production`.
- **The stubs** (`apps/stubs`), test doubles that never run in production.
- Findings that require a compromised host, compromised AWS account, or leaked deployment
  secrets.
- Denial of service through resource exhaustion of a deployment you operate yourself, or
  spending your own provider budget.
- Moderation quality (a false negative of the moderation provider) unless it comes from a
  bug that skips moderation altogether.

## Hardening checklist for operators

- Deploy with the Terraform in `infra/terraform` (or match it): private subnets, TLS
  everywhere, encryption at rest with a customer-managed key, Redis with TLS and an AUTH
  token, secrets only in Secrets Manager.
- Keep `NODE_ENV=production`: the API refuses to boot with development secrets, local
  storage, the mail outbox, inline jobs, stub search or moderation, or `FETCH_ALLOW_HOSTS`.
- Put provider keys in the `<prefix>/provider-keys` secret by hand rather than in
  `terraform.tfvars`, so they stay out of Terraform state.
- Serve the web app and the API on one HTTPS host so the refresh cookie stays first-party
  and `Secure`.
- Choose a registration mode: `INVITE_ONLY` with your own email domains, or `CLOSED`, for a
  private deployment.
- Set quota tiers that match your budget, and spending limits in each provider's console.
- For sensitive use, turn web search off (it is the only path that sends model-chosen
  requests to the public web), and consider fully local models (Ollama or vLLM) with the
  bundled SearXNG.
- Enable CloudFront and WAF (`enable_cdn`, on in `aws-prod`) for public deployments.
- Subscribe someone to the alarm topic (`alarm_email`).
