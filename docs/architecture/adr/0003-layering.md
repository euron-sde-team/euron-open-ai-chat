# ADR 0003: Layered API

## Status

Accepted.

## Context

The same rules are reached from HTTP routes, background jobs, the CLI, the demo seed and
the tests. A turn is started by a send and by a regenerate; usage is recorded by turns,
the image studio, dictation and read aloud; a file is made READY by the processing job
whether it was uploaded or generated. Ownership rules (a file, a conversation or a turn of
someone else is a 404) must hold on every path. URL, file and network rules must be
unit-testable without a database or a network.

## Decision

The API ([`apps/api/src`](../../../apps/api/src)) is layered:

| Layer | Folder | Responsibility |
| --- | --- | --- |
| Routes | `routes/` | One `router.<method>(path, ...guards, ctrl.fn)` per endpoint with a doc comment; `authenticate` and `rateLimit` guards ([`routes/index.ts`](../../../apps/api/src/routes/index.ts)) |
| Controllers | `controllers/` | Parse input with strict zod schemas ([`core/validate.ts`](../../../apps/api/src/core/validate.ts)), call one service, write the response or open the event stream |
| Services | `services/` | Business rules and transactions; take an `Actor`, never a request ([`core/context.ts`](../../../apps/api/src/core/context.ts)). The turn engine lives in [`services/chat/`](../../../apps/api/src/services/chat/turns.ts) |
| Domain | `domain/` | Pure rules: the SSRF address checks, URL shapes, file type and magic-byte rules, chunking and token estimates, usernames, display names |
| Repositories | `repositories/` | Kysely queries; methods accept an optional `Executor` so callers pass a transaction |
| Presenters | `presenters/` | Rows to DTOs from `@open-chat/types`, field by field ([`presenters/chat.presenter.ts`](../../../apps/api/src/presenters/chat.presenter.ts)) |
| Integrations | `integrations/` | Model adapters, search, page fetching, images, speech, moderation, extraction, storage, mail, Redis |

- Identity always comes from the access token; no body field names the acting user.
- Writes go through `requireActive(actor)`; admin services start with `requireAdmin`.
- Background work is a named job enqueued through `Effects` after commit
  ([`core/effects.ts`](../../../apps/api/src/core/effects.ts),
  [`jobs/registry.ts`](../../../apps/api/src/jobs/registry.ts)).
- `scripts/gen-openapi.ts` reads the route files, so the one-statement-per-route shape is
  enforced by `pnpm openapi --check` in CI.

## Consequences

Positive:

- Services run unchanged from jobs, the CLI, the demo seed and the in-process integration
  harness.
- The rules that guard the server from its users (`net-guard.ts`, `file-rules.ts`,
  `chunking.ts`) are pinned by unit tests in
  [`apps/api/test/unit`](../../../apps/api/test/unit).
- Nothing above `integrations/` knows which provider, storage or mail transport is in use.

Trade-offs:

- More files per feature; some indirection for simple reads.
- The layering is a convention: a few services (the turn engine, tools, shares) run small
  queries inline instead of adding a repository method.

## Alternatives considered

- **An ORM with active records.** Hides the queries that carry the ownership checks.
- **Fat controllers.** Turns, usage and file processing would not be reusable from jobs.
