# ADR 0013: Native token mode for mobile clients

## Status

Accepted.

## Context

The web app keeps the access token in memory and the refresh token in an httpOnly
`chat_refresh` cookie scoped to `/api/auth`
([`apps/web/src/lib/session.ts`](../../../apps/web/src/lib/session.ts)). A React Native app
has no browser cookie jar it controls well, no same-site protection to lean on, and a far
better place for a long-lived secret: the platform keystore (iOS Keychain, Android
Keystore). It still needs the same session semantics: short access tokens, one refresh
token per login that rotates on every use, and family revocation when a rotated token is
replayed. A ChatGPT-like app built on this API is a first-class client.

## Decision

- A client opts in per request with `X-Client: native` (compared without case). The header
  changes only the transport of the refresh token, never what a session is
  ([`controllers/auth.controller.ts`](../../../apps/api/src/controllers/auth.controller.ts)).
- Every endpoint that issues a session (sign-up without verification, verify-email,
  sign-in including the second factor, refresh) answers `IssuedNativeSession`: the
  `AuthResult` plus `refreshToken` and `refreshExpiresAt`. No `Set-Cookie` header is sent
  or cleared in native mode.
- `POST /api/auth/refresh` and `POST /api/auth/logout` take a strict body
  `{ refreshToken }` in native mode. Without the header they behave as before, cookie only.
- Rotation and reuse detection are one code path (`refresh` in
  [`services/auth.service.ts`](../../../apps/api/src/services/auth.service.ts)): only the
  SHA-256 is stored, and a rotated token presented 10 seconds or more after its rotation
  revokes the family and audits `session.reuse_detected`.
- Everything else is the same bearer API: the turn stream reader in
  `@open-chat/api-client` has an `xhr` transport for React Native, and uploads report
  progress through XHR ([mobile-clients.md](../../guides/mobile-clients.md)).

## Consequences

Positive:

- One session model, one table, one set of tests for both clients
  (`native-auth.int.test.ts` covers native login, body refresh, replay revoking the family
  and that cookie mode is unchanged).
- The refresh token never sits in JavaScript-readable storage on the web, and never in a
  cookie jar on a phone.

Trade-offs:

- A native refresh token in a response body is readable by the app's JavaScript; the app
  must keep it only in the keystore and never log it (the API's logger already redacts
  `refreshToken`).
- The header is a client claim. It does not weaken the web: a page that sends it only stops
  receiving the httpOnly cookie, and CORS still limits which origins may call with
  credentials.

## Alternatives considered

- **Cookies in the app.** Couples token storage to an HTTP stack instead of the keystore
  and breaks on platform cookie quirks.
- **A separate `/api/auth/native/*` route set.** Duplicates every session route and its
  tests; the header keeps one route table.
