# Threat model

A STRIDE analysis of Euron Open AI Chat as deployed by the Terraform in `infra/terraform`
(an aws-prod shaped environment with CloudFront and WAF) and the defaults in the code. Each
row names the threat, the control that exists today and what remains. Controls are
described in [security.md](security.md). **Accepted** means a design choice; **open**
means a known gap worth fixing; the rating (low, medium, high) is the impact on a typical
deployment if exploited. Paths are relative to the repository root.

## Defects of the system this was ported from, and what fixes them

The chat was ported from an internal product whose defects shaped this design. Each is
closed by a specific control:

| Defect | Fix in this design | Where |
| --- | --- | --- |
| Attachment IDOR: any attachment id was served to anyone who asked | Every file read is scoped to `owner_id`; foreign ids are 404; message attachments are checked in one owner-scoped query before the message is stored | [`services/file.service.ts`](../../apps/api/src/services/file.service.ts) `ownFile`, `attachableFiles` |
| Client-supplied storage keys | Keys are made by the server; clients send and receive file ids only | [`domain/file-rules.ts`](../../apps/api/src/domain/file-rules.ts) `storageKeyFor` |
| SSRF via redirects | Every hop is shape-checked, resolved, required public and pinned; redirects followed by hand | [`integrations/fetch-page.ts`](../../apps/api/src/integrations/fetch-page.ts), [ADR 0008](adr/0008-ssrf-guard-per-hop-with-dns-pinning.md) |
| Tool output in the system prompt | Tool results are tool messages, wrapped and labelled untrusted | [`services/chat/tools.ts`](../../apps/api/src/services/chat/tools.ts), [ADR 0007](adr/0007-tool-results-as-tool-messages.md) |
| No rate limits | Redis rate limits per route; daily weighted-token and image allowances | [`middleware/rate-limit.ts`](../../apps/api/src/middleware/rate-limit.ts), [`services/quota.service.ts`](../../apps/api/src/services/quota.service.ts) |
| Prompts stored in usage logs | `usage_daily` holds counts only; the logger redacts content fields | [`core/logger.ts`](../../apps/api/src/core/logger.ts), [ADR 0012](adr/0012-no-conversation-text-in-logs.md) |
| Live share links exposing storage keys | Frozen snapshots; images through a share-scoped redirect to a short-lived URL | [`services/share.service.ts`](../../apps/api/src/services/share.service.ts), [ADR 0010](adr/0010-frozen-share-snapshots.md) |
| Plaintext provider keys in the database | Keys only in the environment or Secrets Manager; `keyConfigured` is all an admin sees | [`core/config.ts`](../../apps/api/src/core/config.ts), [ADR 0004](adr/0004-providers-behind-one-interface.md) |
| Raw provider errors shown to users | Failures mapped to stable codes and fixed messages; bodies logged masked | [`integrations/http.ts`](../../apps/api/src/integrations/http.ts), [providers.md](providers.md#4-failure-classification) |

## Scope and trust boundaries

| Boundary | Crossing |
| --- | --- |
| TB1 | Internet to the edge (CloudFront, WAF, ALB): every request is untrusted |
| TB2 | Edge to tasks: TLS ends at the ALB, tasks in private subnets, the CDN's secret origin header required |
| TB3 | Application to its stores (RDS, ElastiCache, S3, Secrets Manager, KMS): IAM task roles, security groups, TLS |
| TB4 | Application to model, search, moderation and push providers: outbound HTTPS with keys from the environment |
| TB5 | Application to arbitrary public web servers (`open_url`): outbound requests chosen by a model |
| TB6 | Browser or app straight to S3 (presigned PUT and signed GET) |
| TB7 | Model output back into the application: tool calls and text, untrusted |

Inside the application:

| Principal | Holds |
| --- | --- |
| Visitor | `GET /api/meta`, sign-up and sign-in, public shared links |
| User | Their own conversations, files, projects, memories, images, shares, preferences, usage |
| Admin | `/admin`: accounts, tiers, providers and models, settings, shares, audit, stats; not conversations |
| A model | The tools offered in a turn; treated as an untrusted client of those tools |
| Content authors on the web | Whatever text a search result, a page or a document puts in front of a model |

## Assets

| Rank | Asset | Why it matters |
| --- | --- | --- |
| 1 | Conversation content, attachments, memories | The users' private thinking and documents |
| 2 | Provider keys and the operator's provider spend | Direct financial loss and quota exhaustion |
| 3 | Credentials and sessions, the JWT and TOTP keys | Account takeover, including of admins |
| 4 | The internal network reachable from the API tasks | SSRF to metadata services, databases, internal APIs |
| 5 | Admin powers and the audit trail | Abuse or loss of accountability |
| 6 | Availability of the API, Redis and the providers | A chat that cannot answer |

## STRIDE by surface

### 1. Conversations and ownership

| STRIDE | Threat | Control | Residual |
| --- | --- | --- | --- |
| I | Read another user's conversation, message or turn events | Every read carries `user_id = actor.id`; turn events check ownership before the stream opens; foreign ids are 404 | Low |
| T | Send into another user's conversation, or under a parent from another conversation | Conversation ownership; `parentId` must be an assistant message of the same conversation (`PARENT_INVALID`) | Low |
| T | Mass assignment (set `userId`, `status`, `model_id` on a message) | Strict schemas, explicit field lists | Low |
| I | Enumerate ids | ULIDs are not secret but every lookup is owner-scoped; share ids are 128 random bits | Low |
| E | An admin reads conversations | No such endpoint exists | Low; a database operator can, see section 10 |

### 2. Turns and streaming

| STRIDE | Threat | Control | Residual |
| --- | --- | --- | --- |
| I | Follow someone else's turn by id | `checkTurn` before the SSE response; the event log key is never exposed | Low |
| T | Cancel someone else's turn | `cancelTurn` checks ownership | Low |
| D | Open many streams | Each stream is a cheap `XRANGE` per wakeup on one shared subscriber; sends limited to 30 a minute and one turn per conversation | Low |
| D | Kill a turn by killing the connection | Turns are decoupled from connections | Low |
| R | Deny having sent a message | Messages are stored with timestamps; there is no signature | Accepted |

### 3. Model providers and keys

| STRIDE | Threat | Control | Residual |
| --- | --- | --- | --- |
| I | Read a provider key through the API | No key column, no key in any DTO; canary test | Low |
| I | Keys in logs | Header and field redaction; `maskSecrets` on provider bodies | Low |
| I | Provider error text leaking account details | Fixed messages per failure class | Low |
| I | Keys in Terraform state | By default the secret is created with `set-me` placeholders and filled by hand; passing `provider_keys` puts them in state | Accepted, documented |
| S | A provider endpoint is spoofed (DNS, base URL) | HTTPS to fixed default hosts; custom `base_url` is admin configuration | Low; an admin can point a provider anywhere (section 10) |
| T | A compromised or malicious provider returns hostile output | Treated as untrusted text and tool calls (sections 4 and 5) | Medium, accepted: the operator chooses providers |
| I | Conversation content sent to third parties | Inherent: prompts go to the configured providers, search queries to the search provider | Accepted; Ollama or vLLM plus SearXNG keeps everything in the operator's network |

### 4. Tools and SSRF

| STRIDE | Threat | Control | Residual |
| --- | --- | --- | --- |
| E, I | `open_url` to the metadata service, localhost or private ranges | Shape check, every resolved address public, IPv4-in-IPv6 unwrapped | Low |
| E, I | A public page redirects to an internal address | Manual redirects, every hop re-checked, at most 4 | Low |
| E, I | DNS rebinding between check and connect | Connection pinned to the vetted address | Low |
| E | Non-default ports to reach internal services on public IPs | Only 80 and 443 | Low |
| D | Huge or slow pages | 2 MB cap, 12 s deadline, text types only | Low |
| T | `FETCH_ALLOW_HOSTS` left on in production | Boot refused | Low |
| I | IPv6 ranges `isPublicAddress` judges public but that route internally on a given network | Relies on `ipaddr.js` range names | Low, open: verify on networks with unusual IPv6 routing |

### 5. Prompt injection and untrusted content

| STRIDE | Threat | Control | Residual |
| --- | --- | --- | --- |
| T | A page, search snippet or document instructs the model to ignore its rules | Tool messages, untrusted labels, the system prompt rule, fenced user preferences | Medium, accepted: no prompt-level defence is complete |
| I | Exfiltrate conversation text by making the model open an attacker URL with data in the query | `open_url` reaches only public hosts; tool calls capped at 8 | **Medium, open.** A public attacker server can receive what the model puts in a URL. Mitigation today: disable web search (deployment feature, user default, or per message). A possible fix: only allow `open_url` for URLs that appeared in the conversation or in search results |
| T | Injected `remember` plants a persistent instruction | Memories are visible and deletable, labelled as remembered facts, capped at 200; memory can be turned off | Medium, open: a planted memory persists until the user notices |
| T | Injected `generate_image` burns the user's image allowance | Bounded by the daily image allowance and 8 calls per turn | Low |
| T | Model output injects HTML or scripts into the page | Markdown without raw HTML, nonce CSP, safe link attributes | Low |
| S | A user overrides the operator's system prompt through custom instructions | Fenced and labelled as preferences; the operator rules and addendum come before them | Medium, accepted: a determined user can still steer their own model |

### 6. Files

| STRIDE | Threat | Control | Residual |
| --- | --- | --- | --- |
| I | Read another user's file | Owner-scoped reads; signed URLs only for the owner's `READY` files | Low |
| T | Upload one type and claim another | Extension and allowlist at declare, magic bytes on the stored object at complete | Low |
| T | Stored XSS through an uploaded HTML or SVG | Refused as declared types; text formats served as `text/plain`; the bucket is a different origin | Low |
| I | EXIF location in shared photos | Images re-encoded without metadata | Low |
| T | Swap the object after `complete` | The presigned PUT expires after 10 minutes and is signed over type and length; processing reads the object once | Low, open: a client could PUT again inside the 10 minutes after `complete`; the processed result overwrites the key |
| E | A malicious document exploits a parser | unpdf, mammoth and exceljs in the worker; no macros or external references; no malware scanning | Medium, open |
| D | Decompression bombs | Images capped at 20 MB and decoded with `failOn: "error"`; spreadsheets read at most 5000 rows; extracted text capped | Low |

### 7. Shares

| STRIDE | Threat | Control | Residual |
| --- | --- | --- | --- |
| I | Guess a share link | 128 random bits | Low |
| I | A share shows messages added after sharing | Frozen snapshot | Low |
| I | A share exposes storage keys or other files | Snapshot holds file ids; the image route serves only those ids, through 15-minute signed URLs | Low |
| I | A link keeps working after the owner regrets it | Owner or admin revoke takes effect at once; ban, erase and turning sharing off also kill it | Low; copies already made by viewers remain |
| D | Scrape shares | 120 reads a minute per IP | Low |

### 8. Account takeover

| STRIDE | Threat | Control | Residual |
| --- | --- | --- | --- |
| S | Credential stuffing | Two failure budgets, uniform answers, bcrypt 12 | Low |
| S | Stolen refresh token | httpOnly path-scoped cookie; rotation with reuse detection revokes the family | Low |
| S | Stolen access token (XSS) | Memory only, 15 minutes, nonce CSP | Low |
| S | Native refresh token lifted from the app | Keystore storage is the app's responsibility; rotation and family revoke apply | Medium, accepted |
| T | CSRF on refresh or logout | SameSite=Lax, path scope, Origin check | Low |
| S | TOTP brute force | The sign-in budgets; each code works once | Low |
| E | Sign up into an invite-only deployment | Domain allowlist and email verification | Low |

### 9. Cost abuse

| STRIDE | Threat | Control | Residual |
| --- | --- | --- | --- |
| D | One account spends the provider budget | Daily weighted-token allowance, 30 sends a minute, 4 rounds and 8 tools per turn | Low |
| D | Parallel image requests past the limit | Atomic Lua reservation | Low |
| D | Overshoot the token limit with long turns | Charged after the fact; at most the turns already started | Low, accepted |
| D | Many accounts | Registration modes, email verification, sign-up rate limits | Medium, accepted for `OPEN` deployments |

### 10. Admins and operators

| STRIDE | Threat | Control | Residual |
| --- | --- | --- | --- |
| E | A user reaches `/api/admin` | `requireAdmin` on every call | Low |
| E | An admin locks everyone out | `LAST_ADMIN`, `SELF_ACTION`, admins must be demoted before suspension or ban | Low |
| R | An admin denies a change | Audit rows with before and after values in the same transaction | Low |
| I | A malicious admin redirects a provider `base_url` to capture prompts | Admins are trusted with configuration; changes are audited | Medium, accepted |
| I | A malicious admin adds a system prompt addendum that extracts data | Same | Medium, accepted |
| I | A database or infrastructure operator reads conversations | Conversations are stored in plaintext (RDS encrypted at rest) | Accepted: self-hosting means trusting the host |

### 11. Availability

| STRIDE | Threat | Control | Residual |
| --- | --- | --- | --- |
| D | Redis outage | Rate limits fall back to memory; turns fail cleanly; aws-prod failover | Medium |
| D | Provider outage | Stable error codes; users can switch models | Accepted |
| D | A task dies mid-turn | The sweep fails the turn after 15 minutes | Low |
| D | Large JSON bodies | 2 MB limit | Low |
| D | Slow-loris SSE | ALB idle timeout, keep-alive, per-user send limits | Low |

### 12. Push notifications

| STRIDE | Threat | Control | Residual |
| --- | --- | --- | --- |
| I | Answer text on a locked screen or at Google and Apple | Generic text by default; `PUSH_PREVIEW` is an explicit operator choice | Low; accepted when the operator turns previews on |
| T | Arm a push on another user's turn | `notify` reads the turn with `findOwnedMessage`; foreign ids are 404 | Low |
| S | Register someone else's token to receive their notifications | A token is issued by FCM to one app install and is not guessable; registering moves it to the caller, so the earlier account stops receiving, and the notification carries no text by default | Low |
| I | Device tokens leak through the API or logs | `PushDevice` has no token field; failures log the device id; `token` is redacted | Low |
| E | Pushes keep reaching a phone after the account is taken back | Sign out everywhere, password change or reset, ban and deletion delete every device of the account | Low |
| I | The FCM service account key leaks | Secrets Manager on AWS, never logged; only the messaging role, so it can send notifications to this app's devices and nothing else | Low |
| T | `PUSH_PROVIDER=stub` left on in production | Boot refused | Low |
| D | Push volume as a cost or spam vector | One push per armed answer per device, bounded by the send rate limit; FCM itself is free | Low |

## Summary of open items

| Item | Rating | Suggested fix |
| --- | --- | --- |
| Exfiltration through `open_url` under prompt injection | Medium | Restrict `open_url` to URLs present in the conversation or search results; or a per-deployment switch for `open_url` separate from search |
| Persistent injected memories | Medium | Ask the user to confirm assistant-written memories |
| No malware scanning of documents | Medium | A scanning step in `files.process` |
| Re-PUT inside the presign window after `complete` | Low | Copy to a final key at processing, or tighten the presign TTL |
| Sweep based on `created_at`, no heartbeat | Low | A heartbeat key per running turn |
| No SSO | Low | OIDC sign-in |
