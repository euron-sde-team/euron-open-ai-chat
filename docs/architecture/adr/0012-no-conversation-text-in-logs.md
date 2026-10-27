# ADR 0012: No conversation text in usage rows or logs

## Status

Accepted.

## Context

What people type into a private assistant is often the most sensitive text they write:
health questions, drafts of hard emails, source code, customer data. Logs are shipped to
log services, kept for a year, read by on-call engineers and attached to bug reports.
Usage tables are read by admins. The system this was ported from stored prompts in its
usage logs, so anyone with access to usage reporting could read what everyone asked.

## Decision

- `usage_daily` holds counts and a model id per user per UTC day: messages, input,
  output and weighted tokens, images, tool calls. No prompt, answer or file name
  ([`db/migrations/0001_init.sql`](../../../db/migrations/0001_init.sql),
  [`services/quota.service.ts`](../../../apps/api/src/services/quota.service.ts) `recordUsage`).
- The logger redacts by field name, at the top and up to three levels below: credentials (`password`,
  `token`, `refreshToken`, `apiKey`, `authorization`, `cookie`, `x-api-key`,
  `x-goog-api-key`, ...) and conversation fields (`content`, `prompt`, `messages`,
  `input`) ([`core/logger.ts`](../../../apps/api/src/core/logger.ts)). The request
  serializer logs method, URL and id only, with signed local file tokens masked
  ([`app.ts`](../../../apps/api/src/app.ts)).
- Provider error bodies are logged truncated to 600 characters with key-shaped strings
  masked (`maskSecrets` in [`integrations/http.ts`](../../../apps/api/src/integrations/http.ts)).
- `messages.tool_trace` keeps tool labels and status only, not tool inputs or outputs.
- The audit trail records who did what to which entity (role changes, suspensions, tier
  changes, settings before and after), never message text.
- Admins have no endpoint that returns another user's conversations
  ([`routes/admin.routes.ts`](../../../apps/api/src/routes/admin.routes.ts)); account erase
  deletes them without reading them.
- `logger-redaction.test.ts` pins the redaction list.

## Consequences

Positive:

- A leaked log archive or an over-broad dashboard does not leak conversations.
- Admins can manage cost and abuse from numbers alone.
- The privacy promise is simple to state: conversations live in `messages` and nowhere
  else (plus share snapshots the owner created).

Trade-offs:

- Debugging a bad answer needs the user's cooperation (a share link or an export), not a
  log search.
- Redaction is by field name: a log call that put conversation text under another key
  would not be caught; reviews watch for it.
- No per-message analytics (topics, prompt lengths) for the operator.

## Alternatives considered

- **Logging prompts with a retention limit.** Still copies the most sensitive data into
  the least protected system.
- **An admin "view conversation" tool for support.** Convenient, and exactly the access
  this product promises not to have.
