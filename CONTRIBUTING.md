# Contributing

Thanks for helping improve Euron Open AI Chat. This guide covers the workflow, the bar a
change has to clear, and the conventions the codebase follows.

## Ground rules

- **Open an issue first** for anything larger than a bug fix or a docs tweak, so we can
  agree on the approach before you invest time.
- **One concern per pull request.** A refactor and a feature are two PRs.
- **Security issues go through private reporting**, never a public issue. See
  [SECURITY.md](SECURITY.md).
- By contributing you agree your work is released under the [MIT License](LICENSE).

## Development setup

Requirements: Docker, Node 22+, pnpm 9 (`corepack enable`).

```bash
pnpm install
make up          # Postgres, Redis, the AWS emulator (provisioned by Terraform), Mailpit,
                 # SearXNG, the stubs (models, images, speech, moderation, search),
                 # then migrate, api, worker and web
make demo        # an admin, four members, providers and models on the Stub provider,
                 # sample chats (prints the logins and the demo password)
make test        # unit tests across every package
```

The app is at http://localhost:3540 and every mail it sends is readable at
http://localhost:8056. No provider key is needed: the demo's Stub provider answers
deterministically. [docs/guides/quickstart-local.md](docs/guides/quickstart-local.md)
lists every port and how to add a real key.

## Before you open a pull request

Each of these must pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
make test-integration            # API (HTTP) against a real Postgres and Redis, stubs in-process
make test-matrix                 # when you touched storage or mail backends
make e2e                         # when you touched a user flow or infrastructure
make tf-validate tf-lint tf-security   # when you touched infra/terraform
pnpm openapi --check             # when you touched a route (pnpm openapi regenerates)
make sanitize                    # no credentials, account ids, real emails or IPs
```

[docs/guides/testing.md](docs/guides/testing.md) explains each layer and the stub trigger
words that steer the fake models.

## Conventions

**Layers (api).** Routes declare endpoints and guards; controllers parse the request with
strict zod schemas and write the response; services hold the business rules and take an
`Actor`, never a request; repositories hold the Kysely queries; presenters build DTOs field
by field. Background work (file processing, summaries, maintenance) is a BullMQ job
enqueued after the transaction commits. Pure rules (file types and sniffing, chunking, the
address and URL guards) live in `apps/api/src/domain` and have unit tests
([ADR 0003](docs/architecture/adr/0003-layering.md)).

**Every query is scoped to its owner.** A conversation, message, turn, file, project,
memory, image or share is read with the actor's id in the query, and another account's id
is a 404. A new endpoint that returns user content gets an integration test proving a
second account cannot read it. Admin endpoints never return conversation content.

**Clients reference files by id.** Never accept or return a storage key.

**Provider keys stay in the environment.** Never add a key column, a key field to a DTO, or
a log line that could carry one. Provider failures go through `failFromResponse` and reach
users only as a stable code ([ADR 0004](docs/architecture/adr/0004-providers-behind-one-interface.md)).

**Outside content is data.** Tool results go back to the model as tool messages, wrapped
and labelled untrusted, never into the system prompt. Any new outbound fetch chosen by a
model goes through the per-hop SSRF guard in `integrations/fetch-page.ts`
([tools-and-safety.md](docs/architecture/tools-and-safety.md)).

**No conversation text in logs or usage rows.** Log ids and counts; the logger redacts
`content`, `prompt`, `messages` and `input`, but do not rely on it
([ADR 0012](docs/architecture/adr/0012-no-conversation-text-in-logs.md)).

**The turn event catalogue is a contract.** `packages/types/src/events.ts` is read by the
web app and by mobile clients that vendor it. Add fields, do not rename or remove them, and
update [docs/api/streaming.md](docs/api/streaming.md) in the same PR.

**Routes stay declarative.** One `router.<method>("<path>", ...guards, ctrl.fn);` per
endpoint with a `/** doc comment */` above: `scripts/gen-openapi.ts` builds
docs/api/openapi.yaml from exactly that shape.

**Configuration is validated.** Every environment variable is declared in
`apps/api/src/core/config.ts` and nowhere else; a new one is documented in
[docs/guides/configuration.md](docs/guides/configuration.md) in the same PR, and
security-relevant ones are enforced at boot by `assertProductionConfig`.

**Database changes are new migrations.** Add `db/migrations/NNNN_description.sql` and update
`apps/api/src/db/types.ts`. Never edit an applied migration: the runner refuses to start
when a checksum changes.

**New providers and tools get stubs.** Teach `apps/stubs/server.mjs` to speak the new wire
format or answer the new tool, so the integration suite stays hermetic
([providers.md](docs/architecture/providers.md#7-adding-a-provider-or-a-model)).

**Comments explain why.** The code says what it does. Comments are for the constraint, the
incident, or the trade-off that made it this way.

**Style.** Prettier and ESLint settle formatting. TypeScript strict mode everywhere.

## Commit messages

Imperative mood with an optional scope: `chat: keep sources numbered across rounds`,
`web: keep the composer draft across reloads`. Explain the *why* in the body when it is not
obvious.

## Architecture decisions

A change that alters a documented decision (single deployment, layering, providers and
keys, turn streaming, the message tree, tool results, the SSRF guard, search, shares,
quotas, logging, native token mode, deployment topology) needs a new or updated ADR in
[docs/architecture/adr/](docs/architecture/adr/README.md) explaining the trade-off, linked
from the pull request.
