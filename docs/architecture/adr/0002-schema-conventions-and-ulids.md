# ADR 0002: Relational schema, `timestamptz(3)`, ULID keys

## Status

Accepted.

## Context

A chat app is mostly lists: conversations by recency, messages in order, files, images,
memories, shares, the audit trail. They grow without bound and are read newest first, so
pagination must stay fast at any depth and must not skip or repeat rows while new
messages arrive. Ids appear in URLs and in client caches, and a phone that keeps them must
be able to sort them. The schema also carries rules (one default quota tier, one default
model per kind, text limits) that should hold even if the application has a bug.

## Decision

- PostgreSQL 16, one forward-only migration set applied by
  [`db/migrate.ts`](../../../db/migrate.ts) (checksummed, under an advisory lock). The
  whole first schema is [`db/migrations/0001_init.sql`](../../../db/migrations/0001_init.sql).
- Runtime queries use Kysely with types generated into
  [`apps/api/src/db/types.ts`](../../../apps/api/src/db/types.ts); no ORM.
- Primary keys are ULIDs stored as `text`, made by a monotonic factory in the API
  ([`core/ids.ts`](../../../apps/api/src/core/ids.ts)). They sort by creation time and
  break ties in keyset cursors. Share ids are the one exception: 128 random bits
  ([ADR 0010](0010-frozen-share-snapshots.md)). Provider ids are admin-chosen slugs.
- Timestamps are `timestamptz(3)` and every process runs with `TZ=UTC`. Millisecond
  precision is exactly what a JavaScript `Date` holds, so a cursor built from a `Date`
  equals the stored value.
- Lists use keyset cursors, never `OFFSET`: opaque base64url JSON of `[at, id]`
  ([`repositories/keyset.ts`](../../../apps/api/src/repositories/keyset.ts)), each served
  by an index in the same order (`conversations_list_idx`, `files_owner_idx`,
  `images_user_idx`, `audit_log_recent_idx`).
- Rules the database can hold, it holds: text limits as `CHECK`, enums as PostgreSQL
  enum types, `quota_tiers_one_default` and `models_one_default_per_kind` as partial
  unique indexes, the conversation leaf as a deferrable foreign key.
- `int8` and `numeric` parse as JavaScript numbers
  ([`db/kysely.ts`](../../../apps/api/src/db/kysely.ts)); token counts stay far below 2^53.

## Consequences

Positive:

- Pages cost the same at the first and the ten-thousandth conversation; new messages
  never shift a page.
- Ids are generated before insert, so a send can return the question and answer ids in
  one transaction and a client can render them at once.
- Bugs that would break a uniqueness rule fail loudly at the database.

Trade-offs:

- No page numbers or totals on lists; the UI uses infinite scroll.
- A schema change is a new SQL migration plus a regenerated `types.ts`; an applied
  migration is never edited (the runner refuses a changed checksum).
- ULIDs reveal creation time, which is why share links do not use them.

## Alternatives considered

- **UUIDv4 keys.** Not sortable, so every list needs a separate tie-breaker and clients
  cannot order ids.
- **`OFFSET` pagination.** Slows down with depth and skips rows while a turn inserts
  messages.
- **A document store for conversations.** Branching, ownership checks and full-text
  search across messages are all easier as relational rows with indexes.
