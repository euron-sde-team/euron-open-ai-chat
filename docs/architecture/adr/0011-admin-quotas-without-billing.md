# ADR 0011: Admin-managed quotas, no billing

## Status

Accepted.

## Context

Every answer costs the operator money at a model provider. A deployment for a team or a
community needs to stop one person (or one stolen session) from burning the month's
budget in an afternoon, and to give some people more than others. The system this was
ported from had no limits at all. A billing system (plans, payments, invoices) is a
different product and most operators of a private assistant do not charge their users.

## Decision

- Allowances are per user per UTC day: weighted tokens and generated images
  ([`services/quota.service.ts`](../../../apps/api/src/services/quota.service.ts)).
- They come from `quota_tiers` (a `Default` tier is seeded with 200,000 tokens, 20 images
  and 25 MB files; exactly one tier is the default by a partial unique index), with an
  optional `user_quota_overrides` row on top. `NULL` means unlimited. Admins manage tiers
  and overrides in `/admin` ([`db/migrations/0001_init.sql`](../../../db/migrations/0001_init.sql)).
- A model's `weight` multiplies its tokens, so a large model can count 4x and a small one
  0.25x against the same allowance.
- Live counters are in Redis (`quota:<user>:<day>:tokens|images`, kept 48 hours) so every
  task agrees; `usage_daily` is the durable record. A missing counter is seeded from
  `usage_daily` with `SET NX` before the first increment.
- Tokens are charged after a turn, from the provider's usage (estimated when it reports
  none); a turn may start while under the limit and finish a little over it. What a failed
  or cancelled turn already produced still counts.
- Images are reserved before generation with an atomic Lua check-and-increment and
  released if generation fails, so parallel requests cannot draw past the limit.
- Dictation and read aloud charge estimated tokens times the model weight
  ([`services/speech.service.ts`](../../../apps/api/src/services/speech.service.ts)).
- A spent allowance is `QUOTA_EXCEEDED` (a turn error event, or 429 elsewhere); it resets
  at midnight UTC. Rate limits are a separate layer ([quotas.md](../quotas.md)).

## Consequences

Positive:

- The operator's spend is bounded per person per day with one setting, and adjustable per
  group or person without code.
- Counters are shared across tasks and survive a Redis restart.
- Users see their own use (`GET /api/me/usage`) and the admin overview shows totals.

Trade-offs:

- The token limit is soft by one turn; a single very long answer can overshoot.
- Weights are the admin's estimate of relative cost, not provider prices.
- No monthly budgets, no money, no self-service upgrades.

## Alternatives considered

- **Billing with plans and payments.** A different product; can be built on top of tiers.
- **Counting in Postgres only.** A row update per turn on a hot row and no atomic
  reservation for images across tasks.
- **Raw request counts.** A one-line question and a 100-page document would cost the same.
