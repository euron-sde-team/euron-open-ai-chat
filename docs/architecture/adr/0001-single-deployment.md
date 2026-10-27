# ADR 0001: One organisation per deployment

## Status

Accepted.

## Context

Euron Open AI Chat is meant to be self-hosted by one organisation or community: a company
giving its staff a private assistant, a school, a research group, a club. That operator
chooses the model providers, pays for their keys, sets the allowances and decides who may
sign up.

A multi-tenant design (many organisations in one database) would need a tenant key on
every row, every unique index, every Redis key (turn event logs, quota counters, rate
limits) and every storage prefix, tenant-scoped provider keys and model catalogues, and a
super-operator plane above the tenants. Every query would carry a predicate that,
forgotten once, shows one organisation's conversations to another. For a chat product the
conversations are the most sensitive data there is.

## Decision

- One deployment serves exactly one organisation. There is no tenant table and no
  `tenant_id` column ([`db/migrations/0001_init.sql`](../../../db/migrations/0001_init.sql)).
- Isolation inside the deployment is per user: every conversation, message, file,
  project, memory, image and share is owned by a `user_id` (or `owner_id`), and every
  lookup filters on the actor in the query itself
  ([`services/chat/chat.service.ts`](../../../apps/api/src/services/chat/chat.service.ts),
  [`services/file.service.ts`](../../../apps/api/src/services/file.service.ts)).
- The deployment's configuration is one JSON document in `settings` (`key = 'app'`): name,
  tagline, registration mode and allowed domains, features, system prompt addendum,
  retention, minimum app version
  ([`services/settings.service.ts`](../../../apps/api/src/services/settings.service.ts)).
- Provider keys are deployment configuration (environment and Secrets Manager), not data
  ([ADR 0004](0004-providers-behind-one-interface.md)).
- There are two roles, `USER` and `ADMIN`. Admins run the control plane but never read
  anyone's conversations.
- Several organisations means several deployments.

## Consequences

Positive:

- No tenant predicate to forget; unique keys (emails, usernames, provider slugs, tier
  names) are naturally per deployment.
- One model catalogue, one set of keys, one quota policy: simple to reason about and to
  audit.
- Redis keys (`turn:<id>:events`, `quota:<user>:<day>:tokens`, `rl:<name>`) need no
  tenant prefix.

Trade-offs:

- A host serving many small organisations pays for one stack each (database, cache, NAT,
  load balancer).
- No shared identity across deployments.
- Usage is measured per user, not per department; an organisation that wants budgets per
  team models them as quota tiers ([ADR 0011](0011-admin-quotas-without-billing.md)).

## Alternatives considered

- **Multi-tenant with a tenant column.** Cheaper per organisation for a hosted service, at
  the cost of a scoping rule on every query, key and job, for an audience that mostly runs
  one deployment.
- **Workspaces inside one deployment.** Projects already group chats for one person;
  shared team workspaces would need sharing rules for conversations, which this product
  deliberately does not have.
