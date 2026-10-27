# ADR 0008: SSRF guard on every hop, with DNS pinning

## Status

Accepted.

## Context

`open_url` fetches a URL that a model chose, often from a user message or a web page, from
inside the deployment's network. Without a guard it reads the cloud metadata service
(`169.254.169.254`), Redis, Postgres or any internal admin page and hands the content to
the model and the user. The system this was ported from checked the first URL once and then
let `fetch` follow redirects anywhere, so a public page that redirected to an internal
address went straight through. Checking the host name is not enough either: a DNS answer
can change between the check and the connect (rebinding).

## Decision

- Shape checks without DNS ([`domain/net-guard.ts`](../../../apps/api/src/domain/net-guard.ts)
  `checkUrlShape`): `http` or `https` only, default ports only, no `user:pass@`, no
  `localhost`, `.localhost`, `.local` or `.internal` names, and a literal IP must itself be
  public.
- Address checks (`isPublicAddress`): only public unicast passes. Loopback, RFC 1918, ULA,
  link-local (the metadata service), carrier-grade NAT, multicast, documentation and
  unspecified ranges are refused; IPv4 inside IPv6 (mapped, 6to4, NAT64) is unwrapped and
  judged as IPv4.
- Every address the host resolves to must be public, and the connection is pinned to the
  vetted address with an undici `Agent` whose `lookup` returns only that address
  ([`integrations/fetch-page.ts`](../../../apps/api/src/integrations/fetch-page.ts)).
- Redirects are followed by hand (`redirect: "manual"`), at most 4 hops, and every hop goes
  through the shape check, the resolution check and a fresh pinned connection.
- Caps: 12 seconds overall, 6 seconds to connect, 2 MB read, text-like content types only,
  12,000 characters of plain text to the model (scripts, styles and markup dropped).
- Failures reach the model as a short reason ("that address cannot be opened"), never the
  internal detail.
- `FETCH_ALLOW_HOSTS` lets the stubs host through in development and tests; production
  refuses to boot with it set (`assertProductionConfig` in
  [`core/config.ts`](../../../apps/api/src/core/config.ts)).

## Consequences

Positive:

- Redirect chains and DNS rebinding cannot reach internal services; the integration suite
  opens a stub page that redirects to the metadata address and asserts it is refused.
- The rules are pure and unit-tested (`net-guard.test.ts`).
- Response size and time are bounded, so a hostile page cannot tie up a task.

Trade-offs:

- Pages on non-default ports and intranet sites cannot be read, by design.
- A new connection per hop is slower than a pooled client.
- Only the API's own fetches are guarded; the deployment should still keep egress
  restricted at the network level ([tools-and-safety.md](../tools-and-safety.md)).

## Alternatives considered

- **Checking the first URL only.** The flaw this decision fixes.
- **An egress proxy with an allowlist.** Stronger isolation, one more service to run; it
  can be added in front without changing this code.
- **A headless browser.** Executes page scripts, far larger attack surface for a text read.
