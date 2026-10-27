-- Euron Open AI Chat: initial schema.
--
-- Conventions
--   * Primary keys are ULIDs stored as text (sortable by creation time).
--   * Timestamps are timestamptz(3); the API runs with TZ=UTC. Millisecond precision is
--     exactly what a JS Date holds, so a keyset cursor built from a Date round-trips
--     without skipping or repeating rows.
--   * Lists page with keyset cursors, never OFFSET.
--   * One deployment serves one organisation or community: there is no tenant column.
--   * Provider API keys never live in this database. They come from the environment or
--     Secrets Manager (core/config.ts PROVIDER_KEYS), and no endpoint ever returns one.
--   * Usage rows hold counts and model ids only, never prompt or answer text.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── Enums ──────────────────────────────────────────────────────────────────

-- USER: everyone. ADMIN: the control plane (users, models, quotas, settings, audit).
CREATE TYPE user_role AS ENUM ('USER', 'ADMIN');
CREATE TYPE user_status AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'BANNED', 'DEACTIVATED');
CREATE TYPE auth_token_type AS ENUM ('VERIFY_EMAIL', 'RESET_PASSWORD');

-- AVATAR: a profile picture. ATTACHMENT: sent with a message. PROJECT: a project's
-- knowledge file. GENERATED: an image the assistant or the image studio made.
CREATE TYPE file_purpose AS ENUM ('AVATAR', 'ATTACHMENT', 'PROJECT', 'GENERATED');
CREATE TYPE file_kind AS ENUM ('IMAGE', 'PDF', 'DOCUMENT', 'SPREADSHEET', 'TEXT', 'AUDIO', 'OTHER');
-- PENDING: presigned, not uploaded yet. PROCESSING: uploaded, being checked and read.
-- READY: usable. REJECTED: failed a check (type sniffing, size, unreadable).
CREATE TYPE file_status AS ENUM ('PENDING', 'PROCESSING', 'READY', 'REJECTED', 'DELETED');

-- OPENAI_COMPATIBLE covers Groq, OpenRouter, Together, DeepInfra, Ollama, vLLM, LM Studio
-- and anything else that speaks the Chat Completions wire format.
CREATE TYPE provider_kind AS ENUM ('OPENAI', 'ANTHROPIC', 'GEMINI', 'OPENAI_COMPATIBLE', 'STUB');
-- What a model is used for. CHAT models answer messages; IMAGE models draw;
-- TRANSCRIBE and SPEECH back dictation and read aloud.
CREATE TYPE model_kind AS ENUM ('CHAT', 'IMAGE', 'TRANSCRIBE', 'SPEECH');

CREATE TYPE message_role AS ENUM ('USER', 'ASSISTANT');
-- STREAMING: a turn is running. COMPLETE / CANCELLED / FAILED are final.
CREATE TYPE message_status AS ENUM ('STREAMING', 'COMPLETE', 'CANCELLED', 'FAILED');
CREATE TYPE memory_source AS ENUM ('USER', 'ASSISTANT');
CREATE TYPE answer_style AS ENUM ('CONCISE', 'BALANCED', 'DETAILED');

-- ─── Identity ───────────────────────────────────────────────────────────────

-- Quota tiers. Every user is on one (or the default); admins create as many as they like
-- ("Default", "Staff", "Research") and may override one user's numbers on top.
-- NULL means unlimited.
CREATE TABLE quota_tiers (
  id             text PRIMARY KEY,
  name           text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
  daily_tokens   bigint CHECK (daily_tokens >= 0),
  daily_images   integer CHECK (daily_images >= 0),
  max_file_mb    integer NOT NULL DEFAULT 25 CHECK (max_file_mb BETWEEN 1 AND 500),
  is_default     boolean NOT NULL DEFAULT false,
  created_at     timestamptz(3) NOT NULL DEFAULT now(),
  updated_at     timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX quota_tiers_one_default ON quota_tiers (is_default) WHERE is_default;

CREATE TABLE users (
  id                    text PRIMARY KEY,
  email                 citext NOT NULL UNIQUE,
  username              citext NOT NULL UNIQUE CHECK (username ~ '^[a-zA-Z0-9][a-zA-Z0-9-]{1,38}[a-zA-Z0-9]$'),
  -- Cleaned at write time (domain/display-name.ts): never an email address or a phone number.
  display_name          text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  password_hash         text NOT NULL,
  role                  user_role NOT NULL DEFAULT 'USER',
  status                user_status NOT NULL DEFAULT 'PENDING_VERIFICATION',
  email_verified_at     timestamptz(3),
  totp_secret           text,                    -- AES-256-GCM ciphertext (security/totp.ts), never the raw secret
  totp_enabled          boolean NOT NULL DEFAULT false,
  totp_last_step        bigint,                  -- last accepted TOTP time step: a code works once
  suspended_until       timestamptz(3),
  token_version         integer NOT NULL DEFAULT 0,
  avatar_file_id        text,                    -- FK added after files exists
  quota_tier_id         text REFERENCES quota_tiers (id) ON DELETE SET NULL,
  -- Set when the user asks to delete the account; the purge job erases it after the
  -- grace period unless they sign in and cancel.
  deletion_requested_at timestamptz(3),
  last_seen_at          timestamptz(3),
  created_at            timestamptz(3) NOT NULL DEFAULT now(),
  updated_at            timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX users_name_trgm_idx ON users USING gin ((display_name || ' ' || username::text || ' ' || email::text) gin_trgm_ops);
CREATE INDEX users_admin_idx ON users (role) WHERE role <> 'USER';

CREATE TABLE sessions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id    text NOT NULL,                  -- every rotation of one login shares a family
  token_hash   text NOT NULL UNIQUE,           -- sha256 of the refresh token
  user_agent   text,
  ip           inet,
  created_at   timestamptz(3) NOT NULL DEFAULT now(),
  last_used_at timestamptz(3) NOT NULL DEFAULT now(),
  expires_at   timestamptz(3) NOT NULL,
  revoked_at   timestamptz(3),
  replaced_by  text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family_idx ON sessions (family_id);

CREATE TABLE auth_tokens (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type       auth_token_type NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz(3) NOT NULL,
  used_at    timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, type);

-- Single-use two-factor recovery codes, issued ten at a time when TOTP is turned on.
-- Only an HMAC of each code is stored (keyed from TOTP_ENCRYPTION_KEY).
CREATE TABLE totp_recovery_codes (
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hash)
);

-- Per-user preferences that shape every answer. Missing row = defaults
-- (presenters/preferences.presenter.ts).
CREATE TABLE user_preferences (
  user_id             text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- "What should the assistant know about you" and "how should it respond".
  about_me            text NOT NULL DEFAULT '' CHECK (length(about_me) <= 1500),
  custom_instructions text NOT NULL DEFAULT '' CHECK (length(custom_instructions) <= 1500),
  answer_style        answer_style NOT NULL DEFAULT 'BALANCED',
  memory_enabled      boolean NOT NULL DEFAULT true,
  web_search_default  boolean NOT NULL DEFAULT true,
  default_model_id    text,                    -- FK added after models exists
  voice               text NOT NULL DEFAULT 'alloy' CHECK (length(voice) <= 40),
  updated_at          timestamptz(3) NOT NULL DEFAULT now()
);

-- ─── Files ──────────────────────────────────────────────────────────────────

-- Uploads go straight to object storage with a presigned URL; the API only ever hands a
-- client a file id, never a storage key. Every read checks owner_id.
CREATE TABLE files (
  id              text PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose         file_purpose NOT NULL,
  kind            file_kind NOT NULL,
  mime_type       text NOT NULL,
  file_name       text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  declared_size   bigint NOT NULL,
  size_bytes      bigint,
  storage_key     text NOT NULL UNIQUE,
  thumb_key       text,
  width           integer,
  height          integer,
  page_count      integer,
  -- Plain text read out of a document (capped, services/file-processing.service.ts).
  -- Images keep NULL: they reach vision models as image parts, not text.
  extracted_text  text,
  token_estimate  integer,
  status          file_status NOT NULL DEFAULT 'PENDING',
  rejected_reason text,
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  completed_at    timestamptz(3)
);
CREATE INDEX files_owner_idx ON files (owner_id, created_at DESC, id DESC);
CREATE INDEX files_pending_idx ON files (created_at) WHERE status IN ('PENDING', 'PROCESSING');

ALTER TABLE users ADD CONSTRAINT users_avatar_fk FOREIGN KEY (avatar_file_id) REFERENCES files (id) ON DELETE SET NULL;

-- A document cut into overlapping passages for project search. Postgres full-text search
-- ranks them (ADR 0009): no vector database to run.
CREATE TABLE file_chunks (
  id       text PRIMARY KEY,
  file_id  text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  ordinal  integer NOT NULL,
  content  text NOT NULL,
  search   tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  UNIQUE (file_id, ordinal)
);
CREATE INDEX file_chunks_search_idx ON file_chunks USING gin (search);

-- ─── Providers and models ───────────────────────────────────────────────────

-- A provider is an endpoint. Its key is looked up by slug in PROVIDER_KEYS at call time.
CREATE TABLE providers (
  id           text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),   -- the slug
  kind         provider_kind NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  base_url     text CHECK (length(base_url) <= 300),
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz(3) NOT NULL DEFAULT now(),
  updated_at   timestamptz(3) NOT NULL DEFAULT now()
);

-- The one model catalogue the runtime reads. `weight` multiplies tokens against a user's
-- daily allowance (a large model can count 4x, a small one 0.25x).
CREATE TABLE models (
  id                 text PRIMARY KEY,
  provider_id        text NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  kind               model_kind NOT NULL DEFAULT 'CHAT',
  model_ref          text NOT NULL CHECK (length(model_ref) BETWEEN 1 AND 120),   -- the provider's model id
  display_name       text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  description        text NOT NULL DEFAULT '' CHECK (length(description) <= 200),
  supports_vision    boolean NOT NULL DEFAULT false,
  supports_tools     boolean NOT NULL DEFAULT false,
  supports_reasoning boolean NOT NULL DEFAULT false,
  context_window     integer NOT NULL DEFAULT 128000 CHECK (context_window > 0),
  max_output_tokens  integer NOT NULL DEFAULT 4096 CHECK (max_output_tokens > 0),
  weight             numeric(6, 2) NOT NULL DEFAULT 1 CHECK (weight > 0),
  enabled            boolean NOT NULL DEFAULT true,
  is_default         boolean NOT NULL DEFAULT false,
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamptz(3) NOT NULL DEFAULT now(),
  updated_at         timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_ref, kind)
);
CREATE UNIQUE INDEX models_one_default_per_kind ON models (kind) WHERE is_default;

ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_model_fk FOREIGN KEY (default_model_id) REFERENCES models (id) ON DELETE SET NULL;

-- ─── Conversations ──────────────────────────────────────────────────────────

-- A project groups chats under shared instructions and knowledge files.
CREATE TABLE projects (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 4000),
  created_at   timestamptz(3) NOT NULL DEFAULT now(),
  updated_at   timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX projects_user_idx ON projects (user_id, updated_at DESC, id DESC);

CREATE TABLE project_files (
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  file_id    text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  added_at   timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, file_id)
);
CREATE INDEX project_files_file_idx ON project_files (file_id);

-- Messages form a tree (ADR 0006): regenerating an answer or editing a question adds a
-- sibling under the same parent. current_leaf_id marks the branch being shown; the
-- context sent to a model is the path from the root to that leaf.
CREATE TABLE conversations (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id       text REFERENCES projects (id) ON DELETE SET NULL,
  title            text NOT NULL DEFAULT 'New chat' CHECK (length(title) BETWEEN 1 AND 120),
  title_locked     boolean NOT NULL DEFAULT false,   -- the user renamed it: never auto-title again
  current_leaf_id  text,                             -- FK added after messages exists
  pinned_at        timestamptz(3),
  archived_at      timestamptz(3),
  -- A rolling summary of the turns that no longer fit the context budget, and the last
  -- message it covers (services/chat/context.ts).
  summary          text,
  summary_upto_id  text,
  last_message_at  timestamptz(3) NOT NULL DEFAULT now(),
  created_at       timestamptz(3) NOT NULL DEFAULT now(),
  updated_at       timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX conversations_list_idx ON conversations (user_id, last_message_at DESC, id DESC) WHERE archived_at IS NULL;
CREATE INDEX conversations_pinned_idx ON conversations (user_id, pinned_at DESC) WHERE pinned_at IS NOT NULL AND archived_at IS NULL;
CREATE INDEX conversations_project_idx ON conversations (project_id, last_message_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX conversations_title_trgm_idx ON conversations USING gin (title gin_trgm_ops);

CREATE TABLE messages (
  id              text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  parent_id       text REFERENCES messages (id) ON DELETE CASCADE,
  role            message_role NOT NULL,
  content         text NOT NULL DEFAULT '' CHECK (length(content) <= 200000),
  -- The model's visible reasoning summary, when it streams one.
  reasoning       text,
  -- Web sources the answer may cite as [n]: [{ "n": 1, "title", "url", "domain", "snippet" }].
  sources         jsonb NOT NULL DEFAULT '[]',
  -- What the assistant did on the way: [{ "tool", "label", "status" }]. Labels only;
  -- tool inputs and outputs are not kept.
  tool_trace      jsonb NOT NULL DEFAULT '[]',
  model_id        text REFERENCES models (id) ON DELETE SET NULL,
  status          message_status NOT NULL DEFAULT 'COMPLETE',
  error_code      text,
  finish_reason   text,
  input_tokens    integer,
  output_tokens   integer,
  feedback        smallint CHECK (feedback IN (-1, 1)),
  web_search      boolean NOT NULL DEFAULT false,      -- the turn was allowed to search
  search          tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(content, 20000))) STORED,
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  completed_at    timestamptz(3)
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at, id);
CREATE INDEX messages_parent_idx ON messages (parent_id);
CREATE INDEX messages_search_idx ON messages USING gin (search);
CREATE INDEX messages_streaming_idx ON messages (created_at) WHERE status = 'STREAMING';

ALTER TABLE conversations ADD CONSTRAINT conversations_leaf_fk FOREIGN KEY (current_leaf_id) REFERENCES messages (id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

-- Files on a message: what the user attached (INPUT) and what the assistant made (OUTPUT).
CREATE TABLE message_files (
  message_id text NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  file_id    text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  direction  text NOT NULL CHECK (direction IN ('INPUT', 'OUTPUT')),
  position   smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, file_id)
);
CREATE INDEX message_files_file_idx ON message_files (file_id);

-- The image gallery: every image a user generated, in chat or in the studio.
CREATE TABLE images (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  file_id         text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  prompt          text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 4000),
  model_id        text REFERENCES models (id) ON DELETE SET NULL,
  aspect_ratio    text NOT NULL DEFAULT '1:1' CHECK (aspect_ratio IN ('1:1', '4:3', '3:4', '16:9', '9:16')),
  conversation_id text REFERENCES conversations (id) ON DELETE SET NULL,
  message_id      text REFERENCES messages (id) ON DELETE SET NULL,
  source_image_id text REFERENCES images (id) ON DELETE SET NULL,   -- set when this is an edit
  created_at      timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX images_user_idx ON images (user_id, created_at DESC, id DESC);

-- Things the assistant remembers about a user across chats. The user can see, edit and
-- delete every one of them, and turn memory off.
CREATE TABLE memories (
  id                text PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  content           text NOT NULL CHECK (length(content) BETWEEN 1 AND 500),
  source            memory_source NOT NULL,
  source_message_id text REFERENCES messages (id) ON DELETE SET NULL,
  created_at        timestamptz(3) NOT NULL DEFAULT now(),
  updated_at        timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX memories_user_idx ON memories (user_id, created_at DESC);

-- A shared link is a frozen copy of one branch at the moment it was shared (ADR 0010):
-- later messages never appear, and attachments are served by a share-scoped route that
-- only knows the file ids inside the snapshot.
CREATE TABLE shares (
  id              text PRIMARY KEY,                       -- also the public token (ULID + random suffix)
  user_id         text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  conversation_id text REFERENCES conversations (id) ON DELETE SET NULL,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  snapshot        jsonb NOT NULL,
  file_ids        text[] NOT NULL DEFAULT '{}',
  view_count      integer NOT NULL DEFAULT 0,
  revoked_at      timestamptz(3),
  revoked_by      text REFERENCES users (id) ON DELETE SET NULL,
  expires_at      timestamptz(3),
  created_at      timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX shares_user_idx ON shares (user_id, created_at DESC, id DESC);
CREATE INDEX shares_recent_idx ON shares (created_at DESC, id DESC);

-- ─── Quotas and usage ───────────────────────────────────────────────────────

-- One user's numbers on top of their tier. NULL columns fall back to the tier.
CREATE TABLE user_quota_overrides (
  user_id      text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  daily_tokens bigint CHECK (daily_tokens >= 0),
  daily_images integer CHECK (daily_images >= 0),
  note         text CHECK (length(note) <= 300),
  updated_by   text REFERENCES users (id) ON DELETE SET NULL,
  updated_at   timestamptz(3) NOT NULL DEFAULT now()
);

-- Daily totals per user and model, in the UTC day. Counts only (ADR 0012).
CREATE TABLE usage_daily (
  user_id         text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day             date NOT NULL,
  model_id        text NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  messages        integer NOT NULL DEFAULT 0,
  input_tokens    bigint NOT NULL DEFAULT 0,
  output_tokens   bigint NOT NULL DEFAULT 0,
  weighted_tokens bigint NOT NULL DEFAULT 0,
  images          integer NOT NULL DEFAULT 0,
  tool_calls      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, model_id)
);
CREATE INDEX usage_daily_day_idx ON usage_daily (day);

-- ─── Operations ─────────────────────────────────────────────────────────────

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by text REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          text PRIMARY KEY,
  actor_id    text REFERENCES users (id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  ip          inet,
  data        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_recent_idx ON audit_log (created_at DESC, id DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, created_at DESC);

-- ─── Seed rows ──────────────────────────────────────────────────────────────

-- The default tier: generous enough to try the app, small enough to protect a key.
INSERT INTO quota_tiers (id, name, daily_tokens, daily_images, max_file_mb, is_default)
VALUES ('01JDK4V7Q80000000000000000', 'Default', 200000, 20, 25, true);
