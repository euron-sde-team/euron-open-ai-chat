# ADR 0015: Push notifications are armed per answer

## Status

Accepted.

## Context

Answers run on the server and keep running when the phone app goes to the background
([ADR 0005](0005-turns-decoupled-via-redis-streams.md)). The app collects the answer on the
next foreground, but nothing tells the user it is ready. A ChatGPT-like app is expected to
say "your answer is ready" on the lock screen.

A push is not free of cost or risk. Notification text passes through Google (FCM) and, for
iPhones, Apple (APNs), and it shows on a locked screen that anyone nearby can read. The
privacy rule for this product is that conversation text lives in `messages` and nowhere
else ([ADR 0012](0012-no-conversation-text-in-logs.md)). A push for every finished answer
would also buzz a phone while its owner is reading the same answer on the web, or in the
app itself.

## Decision

- **Nothing is pushed unless the app asks for one specific answer.** When the app goes to
  the background while an answer is still being written, it calls
  `POST /api/turns/:id/notify`. That checks the turn belongs to the caller, is an assistant
  message and is still `STREAMING`, then sets `turn:<id>:notify` in Redis for an hour
  ([`services/push.service.ts`](../../../apps/api/src/services/push.service.ts)
  `armTurnNotification`). The web app never calls it, so web users never get pushes.
- **The turn takes the key when it ends.** After `done` is written,
  [`services/chat/turns.ts`](../../../apps/api/src/services/chat/turns.ts) calls
  `afterTurn`, which does one Redis `GETDEL`. When nobody armed the turn that is the whole
  cost. When the key was there and the turn was not cancelled, it queues
  `push.turn-ready` on the `push` queue; the push never runs on the turn's path.
- **A race between arming and finishing answers `finished`.** If the turn ended before the
  `SET`, or between the `SET` and a second read, the key is taken back and the call answers
  `{ state: "finished" }`, so the app follows the turn instead of waiting for a push.
- **Generic text by default.** The notification says the app name and "Your answer is
  ready." (or that it could not be finished). With `PUSH_PREVIEW=true` it uses the chat
  title and the first 120 characters of the answer. The data payload carries only
  `type: "turn"`, `conversationId` and `messageId`.
- **FCM HTTP v1 for both platforms.** FCM delivers to Android and, through APNs, to iOS.
  The APNs key is uploaded to the Firebase project, never to this server. The client signs
  a JWT with the service account key using `node:crypto` and trades it for an access token
  (RFC 7523); no Google SDK ([`integrations/push/fcm.ts`](../../../apps/api/src/integrations/push/fcm.ts)).
- **Devices follow the account that is signed in.** `push_devices.token` is unique: the
  same token registered by another account moves to it. Native sign-out with `deviceToken`
  removes that device; ending every session of an account (sign out everywhere, password
  change or reset, ban, deletion) removes all of them
  ([`repositories/session.repository.ts`](../../../apps/api/src/repositories/session.repository.ts)
  `revokeAllForUser`). A token FCM reports as `UNREGISTERED` or `INVALID_ARGUMENT` is
  deleted.
- **Off unless configured.** `PUSH_PROVIDER` is `none` by default; `meta.features.push`
  tells the app whether to arm at all, and arming on a server without push answers
  `409 PUSH_DISABLED`. `PUSH_PROVIDER=stub` runs the same client against `apps/stubs` and
  is refused in production.

## Consequences

Positive:

- A push happens only when someone left an answer unread on a phone. No noise while the
  user watches the answer, on any client.
- No conversation text leaves the server by default, and none lands in a log: a failed
  send logs the device id and the FCM status only.
- One Redis round trip per finished turn for everyone who did not arm, and no table read.
- One provider, one credential, both platforms. The stub path exercises the real request
  code (JWT signing, token exchange, dead-token handling) in the integration tests.

Trade-offs:

- An app that is killed before it can call `notify` gets no push for that answer; the
  answer is still there on the next launch.
- The arming key lives in Redis for at most an hour. A Redis flush loses pending pushes,
  never answers.
- Self-hosters who want push need a Firebase project, even for iPhones only.
- Generic text is less useful than a preview; operators who accept the trade can turn
  `PUSH_PREVIEW` on.

## Alternatives considered

- **Push after every answer while a device is registered.** Simple, but notifies people
  who are already reading the answer and sends far more text through third parties.
- **Track app foreground state on the server.** Needs a heartbeat or presence channel and
  still guesses; the app knows exactly when it goes to the background.
- **APNs directly for iOS, FCM for Android.** Two providers, two credentials and an APNs key
  on the server, for no gain in what the notification can say.
- **The Firebase Admin SDK.** A large dependency for one HTTP call and a token exchange.
