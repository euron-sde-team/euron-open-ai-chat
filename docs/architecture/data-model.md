# Data model

The whole schema is one migration, [`db/migrations/0001_init.sql`](../../db/migrations/0001_init.sql),
applied by [`db/migrate.ts`](../../db/migrate.ts) (forward-only, checksummed). Runtime
queries use Kysely with types generated into
[`apps/api/src/db/types.ts`](../../apps/api/src/db/types.ts). This page groups the tables
by domain and explains why each exists and which constraints carry a rule.

![Tables grouped by domain: identity, conversations, files, the model catalogue, sharing and images, quotas and operations](../assets/diagrams/data-model.svg)

## Conventions

- **Keys** are ULIDs stored as `text`, generated in the API
  ([`apps/api/src/core/ids.ts`](../../apps/api/src/core/ids.ts)). They sort by creation
  time and break ties in keyset cursors. Two exceptions: `providers.id` is the provider's
  slug (it is also the key into `PROVIDER_KEYS`), and `shares.id` is 128 random bits
  (a ULID carries a timestamp and less randomness) ([ADR 0002](adr/0002-schema-conventions-and-ulids.md)).
- **Timestamps** are `timestamptz(3)` and the processes run with `TZ=UTC`. Millisecond
  precision is what a JS `Date` holds, so a cursor round-trips exactly.
- **Lists page with keyset cursors**, never `OFFSET`; every list has an index serving its
  order ([`apps/api/src/repositories/keyset.ts`](../../apps/api/src/repositories/keyset.ts)).
- **Text limits** are `CHECK (length(...))` in the schema and matched by the zod schemas.
- **Enums** are PostgreSQL enum types.
- **Extensions**: `citext` (emails, usernames), `pg_trgm` (admin user search, title search).
- **Full-text search** uses generated `tsvector` columns with the `simple` configuration
  (no stemming, so it works for any language) and GIN indexes.
- **No tenant column.** One deployment serves one organisation ([ADR 0001](adr/0001-single-deployment.md)).
- **No provider keys.** They live in the environment or Secrets Manager only
  ([ADR 0004](adr/0004-providers-behind-one-interface.md)).
- **Usage rows hold counts only**, never prompt or answer text ([ADR 0012](adr/0012-no-conversation-text-in-logs.md)).

## Enums

| Enum | Values |
| --- | --- |
| `user_role` | `USER`, `ADMIN` |
| `user_status` | `PENDING_VERIFICATION`, `ACTIVE`, `SUSPENDED`, `BANNED`, `DEACTIVATED` |
| `auth_token_type` | `VERIFY_EMAIL`, `RESET_PASSWORD` |
| `file_purpose` | `AVATAR`, `ATTACHMENT`, `PROJECT`, `GENERATED` |
| `file_kind` | `IMAGE`, `PDF`, `DOCUMENT`, `SPREADSHEET`, `TEXT`, `AUDIO`, `OTHER` |
| `file_status` | `PENDING`, `PROCESSING`, `READY`, `REJECTED`, `DELETED` |
| `provider_kind` | `OPENAI`, `ANTHROPIC`, `GEMINI`, `OPENAI_COMPATIBLE`, `STUB` |
| `model_kind` | `CHAT`, `IMAGE`, `TRANSCRIBE`, `SPEECH` |
| `message_role` | `USER`, `ASSISTANT` |
| `message_status` | `STREAMING`, `COMPLETE`, `CANCELLED`, `FAILED` |
| `memory_source` | `USER`, `ASSISTANT` |
| `answer_style` | `CONCISE`, `BALANCED`, `DETAILED` |

## Tables by domain

### Identity

| Table | Holds | Why, and constraints worth knowing |
| --- | --- | --- |
| `quota_tiers` | Named allowance tiers: `daily_tokens`, `daily_images` (NULL = unlimited), `max_file_mb` (1 to 500) | Admins group users ("Default", "Staff", "Research") instead of setting numbers per person. The partial unique index `quota_tiers_one_default` allows exactly one default; the migration seeds "Default" with 200000 tokens, 20 images, 25 MB |
| `users` | Account, profile, role, status, TOTP state, suspension end, `token_version`, `quota_tier_id`, `deletion_requested_at`, `last_seen_at` | `email` and `username` unique (citext); username pattern; `display_name` 1 to 80, cleaned of emails and phone numbers; `totp_secret` is ciphertext; trigram index over name, username and email for the admin search; partial index on non-USER roles |
| `sessions` | One row per refresh token | `token_hash` unique (SHA-256); `family_id` groups every rotation of one login; `replaced_by` marks a rotated row for reuse detection; partial index on live sessions |
| `auth_tokens` | Email verification and password reset tokens | Hash only; single use (`used_at`) |
| `totp_recovery_codes` | HMACs of the ten recovery codes | Primary key `(user_id, code_hash)` |
| `user_preferences` | About me, custom instructions (1500 characters each), answer style, memory on or off, web search by default, default model, voice | A missing row means defaults. These shape every answer through the system prompt ([chat-engine.md](chat-engine.md)); `default_model_id` is `ON DELETE SET NULL` so removing a model never breaks a user |

### Files

| Table | Holds | Why, and constraints worth knowing |
| --- | --- | --- |
| `files` | Every upload and generated image: owner, purpose, kind, MIME type, cleaned file name, declared and verified size, server-made `storage_key` and `thumb_key`, dimensions, page count, `extracted_text` (capped at 400000 characters), `token_estimate`, status, rejection reason | The only handle a client gets is the id; `storage_key` is unique and never leaves the API. `files_owner_idx` serves "my files"; the partial `files_pending_idx` serves the expiry job ([files.md](files.md)) |
| `file_chunks` | Overlapping passages of a document with a generated `search` tsvector | Search over project knowledge and attachments without a vector database ([ADR 0009](adr/0009-postgres-full-text-search.md)); `UNIQUE (file_id, ordinal)`; GIN on `search`; cascades with the file |

### The model catalogue

| Table | Holds | Why, and constraints worth knowing |
| --- | --- | --- |
| `providers` | An endpoint: slug id, kind, display name, optional `base_url`, enabled | The slug (`^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`) is the key into `PROVIDER_KEYS` at call time. No key column exists |
| `models` | `model_ref` (the provider's id), kind, display name, description, `supports_vision`, `supports_tools`, `supports_reasoning`, `context_window`, `max_output_tokens`, `weight` (`numeric(6,2)` above 0), enabled, `is_default`, `sort_order` | The one catalogue the runtime reads. `UNIQUE (provider_id, model_ref, kind)`; partial unique `models_one_default_per_kind` allows one default per kind. `weight` multiplies tokens against allowances ([quotas.md](quotas.md)). Capabilities decide which tools are offered and whether images are sent as pixels |

### Conversations

| Table | Holds | Why, and constraints worth knowing |
| --- | --- | --- |
| `projects` | Name and instructions (4000 characters) | Groups chats under shared instructions and knowledge files |
| `project_files` | Project to file links | Primary key `(project_id, file_id)`; index on `file_id` for "is this file in use" |
| `conversations` | Title, `title_locked`, `project_id`, `current_leaf_id`, pinned and archived timestamps, `summary` and `summary_upto_id`, `last_message_at` | `current_leaf_id` marks the branch on screen ([ADR 0006](adr/0006-message-tree-for-branching.md)); its FK is `DEFERRABLE INITIALLY DEFERRED` because the send transaction inserts the answer and moves the leaf together. `title_locked` stops auto-titles after a rename. The summary records the last message it covers, so it is only used on its own branch. Partial index for the live list, one for pinned, one per project, trigram on title |
| `messages` | `parent_id`, role, content (at most 200000 characters), `reasoning`, `sources` (JSON), `tool_trace` (labels only), `model_id`, status, `error_code`, `finish_reason`, token counts, `feedback` (-1 or 1), `web_search`, generated `search` tsvector over the first 20000 characters | A tree: regenerating adds a sibling answer, editing adds a sibling question. The assistant row is created `STREAMING` and its id is the turn id. `tool_trace` keeps what the assistant did ("Searched the web for ...") but never tool inputs or outputs. Partial `messages_streaming_idx` serves the sweep and "is a turn running" |
| `message_files` | Files on a message, `direction` `INPUT` (attached) or `OUTPUT` (generated), position | Primary key `(message_id, file_id)`; index on `file_id` so a file sent in a message cannot be deleted under the conversation (`409 FILE_IN_USE`) |
| `memories` | Content (1 to 500 characters), source, optional `source_message_id` | Things the assistant remembers across chats; the user can see, edit and delete every one, and turn memory off. Capped at 200 per user in code |

### Sharing and images

| Table | Holds | Why, and constraints worth knowing |
| --- | --- | --- |
| `shares` | Random id, owner, source conversation (`SET NULL`), title, `snapshot` (JSON), `file_ids` (the images frozen into it), `view_count`, `revoked_at`, `revoked_by`, `expires_at` | A frozen copy, so later messages never appear and storage keys are never exposed ([ADR 0010](adr/0010-frozen-share-snapshots.md)). `file_ids` is the allowlist for the share-scoped image route. `shares_recent_idx` serves the admin moderation list |
| `images` | The gallery: file, prompt, model, aspect ratio (`1:1`, `4:3`, `3:4`, `16:9`, `9:16`), the conversation and message it came from, `source_image_id` for edits | One list for images made in chat and in the studio |

### Quotas and usage

| Table | Holds | Why, and constraints worth knowing |
| --- | --- | --- |
| `user_quota_overrides` | One user's `daily_tokens` and `daily_images` on top of their tier, a note, who set it | NULL columns fall back to the tier, so an override can lift one number only |
| `usage_daily` | Per user, UTC day and model: messages, input, output and weighted tokens, images, tool calls | Primary key `(user_id, day, model_id)`, upserted with additive `ON CONFLICT`. The durable record behind the Redis counters and the admin stats. Counts only ([ADR 0011](adr/0011-admin-quotas-without-billing.md)) |

### Operations

| Table | Holds | Why, and constraints worth knowing |
| --- | --- | --- |
| `settings` | `key = 'app'`: the `ChatSettings` JSON document | Merged over the code defaults key by key, so an older stored document keeps working ([`services/settings.service.ts`](../../apps/api/src/services/settings.service.ts)) |
| `audit_log` | Actor, action, entity, IP, data (JSON) | Admin actions, account lifecycle, settings changes (before and after), retention runs. Indexes for recent, by entity and by actor |

## What is deliberately not stored

| Not stored | Why |
| --- | --- |
| Provider, search and moderation keys | Environment and Secrets Manager only; a database dump or an admin endpoint cannot leak them |
| Tool inputs and outputs (search results, page text) | Only labels in `tool_trace` and the numbered `sources`; page text is used for one turn and dropped |
| Prompts or answers in `usage_daily`, the audit log or logs | Usage is counted, not recorded |
| Audio | Dictation reads the upload from memory; read aloud streams through |
| A copy of a file for each share | A share holds file ids; the image route signs a URL for the original |
| Embeddings | Postgres full-text search instead ([ADR 0009](adr/0009-postgres-full-text-search.md)) |

## Deletion and cascades

- Deleting a **user** cascades to everything they own; in practice users are anonymised
  (`anonymiseUser`), which deletes shares, images, conversations, projects, memories,
  preferences and overrides, marks files `DELETED` and keeps `usage_daily` and audit rows
  attached to the anonymised account.
- Deleting a **conversation** cascades to its messages and `message_files`; files stay
  until `maintenance.expire-files` finds them unreferenced. A share made from it keeps
  working (its `conversation_id` becomes NULL) until revoked.
- Deleting a **provider** cascades to its models; a model's removal sets `messages.model_id`,
  `images.model_id` and `user_preferences.default_model_id` to NULL and cascades its
  `usage_daily` rows.
- **Retention** (`settings.retentionDays`) deletes conversations whose `last_message_at`
  is older than the setting, 500 at a time.
