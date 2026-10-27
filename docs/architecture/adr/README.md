# Architecture decision records

Short records of the decisions that shape Euron Open AI Chat: the context, what was
decided, and what it costs. The system as built is described in [HLD.md](../HLD.md) and
[LLD.md](../LLD.md).

| ADR | Decision |
| --- | --- |
| [0001](0001-single-deployment.md) | One organisation per deployment; no tenants |
| [0002](0002-schema-conventions-and-ulids.md) | Relational PostgreSQL schema, `timestamptz(3)`, ULID keys, keyset pagination |
| [0003](0003-layering.md) | Routes, controllers, services, domain, repositories, presenters, integrations |
| [0004](0004-providers-behind-one-interface.md) | Every model provider behind one adapter interface, plain `fetch`, keys never in the database |
| [0005](0005-turns-decoupled-via-redis-streams.md) | Turns run on the server, decoupled from the HTTP connection, with events in Redis Streams |
| [0006](0006-message-tree-for-branching.md) | Messages form a tree; regenerate and edit add siblings |
| [0007](0007-tool-results-as-tool-messages.md) | Native function calling; tool results go back as tool messages, never into the system prompt |
| [0008](0008-ssrf-guard-per-hop-with-dns-pinning.md) | `open_url` checks every redirect hop and pins the connection to the vetted address |
| [0009](0009-postgres-full-text-search.md) | Postgres full-text search over file chunks instead of a vector database |
| [0010](0010-frozen-share-snapshots.md) | Shared links are frozen snapshots with random ids and a share-scoped image route |
| [0011](0011-admin-quotas-without-billing.md) | Daily allowances from admin-managed quota tiers; no billing |
| [0012](0012-no-conversation-text-in-logs.md) | No conversation text in usage rows or log lines |
| [0013](0013-native-token-mode.md) | Native token mode: mobile apps keep the rotating refresh token themselves (`X-Client: native`) |
| [0014](0014-floci-for-local-aws.md) | Floci as the local AWS, provisioned by the production Terraform modules |
| [0015](0015-push-opt-in-per-answer.md) | Push notifications only for an answer the app armed (`POST /api/turns/:id/notify`); generic text by default |
