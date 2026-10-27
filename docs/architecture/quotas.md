# Quotas

Every model call costs the operator money, and a self-hosted chat with no limits lets one
account (or one leaked session) spend a month's budget in an afternoon. The system this was
ported from had no limits at all. This page describes the daily allowances that bound it,
how they are counted across tasks, and what is recorded. There is no billing: admins decide
who gets how much ([ADR 0011](adr/0011-admin-quotas-without-billing.md)). Paths are
relative to the repository root.

Code: [`apps/api/src/services/quota.service.ts`](../../apps/api/src/services/quota.service.ts).

## 1. What is limited

| Allowance | Unit | Checked | Charged |
| --- | --- | --- | --- |
| Daily tokens | Weighted tokens per UTC day | Before a chat turn (`assertTokensLeft`), before dictation and read aloud | After the turn, from the provider's reported usage (or an estimate) |
| Daily images | Generated images per UTC day | Reserved before each generation (`reserveImages`) | At reservation; released if generation fails |
| Max file size | MB per upload | At `POST /api/files` (the smaller of this and the kind ceiling) | n/a |

Rate limits (requests per minute) are a separate, shorter-term control
([LLD.md](LLD.md#7-rate-limits)).

## 2. Where the numbers come from

```
effective = user_quota_overrides (per column, when not NULL)
          ?? the user's quota_tiers row (users.quota_tier_id)
          ?? the default tier (quota_tiers.is_default)
```

`limitsFor(userId)` resolves this in one query. NULL in a tier column means unlimited. An
override column left NULL falls back to the tier, so an admin can lift only the image
limit for one person. The migration seeds one tier, "Default": 200000 tokens, 20 images,
25 MB.

| Admin action | API |
| --- | --- |
| Create, edit, delete tiers; choose the default (exactly one) | `GET/POST /api/admin/tiers`, `PUT/DELETE /api/admin/tiers/:id` |
| Put a user on a tier (null = the default) | `PUT /api/admin/users/:id/tier` |
| Override one user's numbers, with a note | `PUT /api/admin/users/:id/quota` |
| Remove the override | `DELETE /api/admin/users/:id/quota` |

Every change is audited.

## 3. Weighted tokens

```
weighted = ceil((input_tokens + output_tokens) * models.weight)
```

A model's `weight` (set in `/admin/models`) expresses its cost relative to a baseline: the
starter catalogue gives a large model 4, a fast one 1, a small one 0.25 to 0.75. One daily
number then covers every model fairly, and users can stretch their allowance by picking a
lighter model. Dictation charges the transcript's estimated tokens plus 50; read aloud
charges the estimated tokens of the text read; both times the model weight. Image turns
charge images, not tokens.

## 4. Counting across tasks

| Key | Holds | TTL |
| --- | --- | --- |
| `quota:<user>:<YYYY-MM-DD>:tokens` | Today's weighted tokens | 48 h |
| `quota:<user>:<YYYY-MM-DD>:images` | Today's images (including reservations in flight) | 48 h |

- **Redis is the live counter** so every API task and worker sees the same number.
- **`usage_daily` is the durable record.** When a counter is missing (a Redis restart or a
  flushed database), `seeded()` sums today's `usage_daily` and writes it with `SET NX`, so
  two tasks cannot both seed, before the first read or increment.
- **Tokens are charged after the fact.** A turn may start while the user is under the
  limit and finish a little over it; the next turn is refused. Pre-charging an estimate
  would refuse legitimate long answers and need a refund path for every failure.
- **Images are reserved atomically.** A Lua script reads the counter, refuses if adding
  would pass the limit, otherwise increments and renews the TTL, all in one step, so a
  burst of parallel requests cannot draw past the limit. A failed generation calls
  `releaseImages`.
- **The day is UTC.** `usageOf` reports `resetsAt` as the next UTC midnight; the web app
  and `GET /api/me/usage` show it.

## 5. When the allowance is used up

| Where | Answer |
| --- | --- |
| Chat turn | The turn starts, then ends with an `error` event `QUOTA_EXCEEDED` ("You have used today's allowance. It resets at midnight UTC.") and `done` `FAILED`; the question is kept |
| `generate_image` tool | An error result to the model ("The user has no image allowance left today."); the answer continues in words |
| Image-mode turn | `error` `QUOTA_EXCEEDED` |
| Image studio (`POST /api/images`) | `429 QUOTA_EXCEEDED` |
| Dictation, read aloud | `429 QUOTA_EXCEEDED` |

## 6. What is recorded

`recordUsage` upserts one row per user, UTC day and model into `usage_daily`, adding:
`messages`, `input_tokens`, `output_tokens`, `weighted_tokens`, `images`, `tool_calls`.
Counts and the model id only: never the prompt, the answer, a file name or a tool argument
([ADR 0012](adr/0012-no-conversation-text-in-logs.md)). In the system this was ported from,
the usage log stored every prompt, which turned an operational table into a copy of every
conversation.

Usage is recorded for completed turns, and also for failed or cancelled turns that had
already consumed tokens. These rows feed the admin overview (`GET /api/admin/stats`) and a
user's 30-day chart in the admin user sheet, and survive account erasure attached to the
anonymised row.

## 7. Limits of the design

- **Overshoot.** A user can exceed the token limit by at most the size of the turns they
  already started (one turn per conversation, 30 sends a minute).
- **Estimates.** Providers that report no usage are charged an estimate (4 characters per
  token for output, the context estimate for input).
- **No money.** Allowances are not tied to provider prices; `weight` is the operator's
  approximation. For hard spend control, also set limits in each provider's console.
- **Redis loss mid-day** is recovered from `usage_daily`, which is written after each turn,
  so at most the turns in flight are uncounted.
