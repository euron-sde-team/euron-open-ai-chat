# Building a mobile client

How to build a ChatGPT-like iOS or Android app (React Native, or any native stack) against
this API: sessions, the shared contract packages, streaming answers that survive the app
going to the background, uploads with progress, feature flags and forced updates, voice, and
what is not there yet. The full event catalogue is in [../api/streaming.md](../api/streaming.md);
every route in [../api/rest-contract.md](../api/rest-contract.md).

The API has no mobile-only endpoints: the web app and a phone call the same routes. Two
things differ for a native client: how the refresh token travels, and how a response body is
streamed.

## Sessions: native token mode

The web app keeps the refresh token in an httpOnly cookie scoped to `/api/auth`. A native app
sends `X-Client: native` (any case) on the auth endpoints instead
([ADR 0013](../architecture/adr/0013-native-token-mode.md),
[`controllers/auth.controller.ts`](../../apps/api/src/controllers/auth.controller.ts)):

| Call | Native behaviour |
| --- | --- |
| `POST /api/auth/login`, `/signup` (without verification), `/verify-email` | Answer `IssuedNativeSession`: `AuthResult` (`accessToken`, `expiresIn`, `user`) plus `refreshToken` and `refreshExpiresAt`. No `Set-Cookie` header, ever |
| `POST /api/auth/refresh` with body `{ refreshToken }` | A new `IssuedNativeSession`: the refresh token rotates on every use. A rotated token replayed more than 10 s later revokes the whole session family (`session.reuse_detected`) |
| `POST /api/auth/logout` with body `{ refreshToken }` | 204; revokes that session family |
| `POST /api/auth/logout-all` | 204; every session and access token of the account |

Rules for the app:

- Keep the refresh token only in the platform keystore (iOS Keychain, Android Keystore,
  for example through `react-native-keychain` or `expo-secure-store`). Never in
  AsyncStorage, never in a log or crash report.
- Keep the access token in memory. It lives `ACCESS_TOKEN_TTL_SECONDS` (15 minutes by
  default); refresh shortly before `expiresIn` runs out, and on a `401` with code
  `TOKEN_INVALID`, `TOKEN_EXPIRED` or `SESSION_EXPIRED`.
- Refresh single-flight: two concurrent refreshes with the same token would look like a
  replay after the 10 s grace. Serialise them.
- A `401 SESSION_EXPIRED` from refresh means the session is over: clear the keystore and show
  sign-in. `403 ACCOUNT_BANNED` and `ACCOUNT_DEACTIVATED` likewise, with the message.
- `403 ACCOUNT_RESTRICTED` on a write means a suspended account: it can read its chats but
  not send.

Two-factor sign-in works the same as on the web: `login` answers `{ totpRequired: true }`;
send the code as `totp`, or an unused `recoveryCode`.

## The contract packages: vendor them

Two workspace packages are written to run in React Native as well as the browser:

| Package | Holds |
| --- | --- |
| [`packages/types`](../../packages/types/src/index.ts) | Every DTO, enum and the `TurnEvent` union ([`events.ts`](../../packages/types/src/events.ts)). Types only, no runtime code |
| [`packages/api-client`](../../packages/api-client/src/index.ts) | `createApiClient`: typed endpoint groups, `ApiError` with the stable `code`, single-flight refresh, `followTurn` (the resumable stream reader, [`stream.ts`](../../packages/api-client/src/stream.ts)) and `uploadFile` / `putWithProgress` ([`upload.ts`](../../packages/api-client/src/upload.ts)). No dependencies besides `@open-chat/types` |

They are private (`"private": true`) and not published to npm. Copy them into the app
repository at a pinned commit of this repository, for example under `vendor/open-chat/`, and
point your bundler's aliases (or a `file:` dependency) at the copy. They ship TypeScript
source; Metro and Babel compile it like your own code.

Keep the copy honest with a drift check in the app's CI: record the commit you vendored, and
fail when the copy differs from that commit's files.

```bash
#!/usr/bin/env bash
# scripts/check-vendored-api.sh: the vendored contract must equal the pinned upstream commit.
set -euo pipefail
PIN="$(cat vendor/open-chat/UPSTREAM_COMMIT)"
tmp="$(mktemp -d)"
git clone --quiet --filter=blob:none https://github.com/euron-sde-team/euron-open-ai-chat "$tmp"
git -C "$tmp" checkout --quiet "$PIN"
for pkg in types api-client; do
  diff -ru "$tmp/packages/$pkg/src" "vendor/open-chat/$pkg/src"
done
echo "vendored contract matches $PIN"
```

To upgrade, bump `UPSTREAM_COMMIT`, copy the two `src` directories again, and let the
TypeScript compiler show what changed. Read the new `docs/api/openapi.yaml` diff for routes
too. A server older than your app may lack fields: treat optional ones as optional.

### Wiring the client in native mode

Pass a `native` token store to `createApiClient`. The client then sends `X-Client: native`
on every request (including the streaming reader), never uses cookies, saves the refresh
token that `signup`, `verifyEmail` and `login` return, refreshes with `{ refreshToken }` in
the body (single-flight, retried once on a `401`), keeps the rotated token, and sends then
forgets the token on `logout`. When the server ends the session it clears the store and
calls `onSignedOut`.

```ts
import { createApiClient } from "@open-chat/api-client";
import * as Keychain from "react-native-keychain";

let accessToken: string | null = null;

export const api = createApiClient({
  baseUrl: "https://chat.example.com/api",
  getAccessToken: () => accessToken,
  onRefresh: (r) => (accessToken = r.accessToken),
  onSignedOut: () => (accessToken = null),
  crossTabLock: (fn) => fn(), // one JS runtime: the built-in single-flight is enough
  native: {
    getRefreshToken: async () => (await Keychain.getGenericPassword({ service: "chat-refresh" }))?.password ?? null,
    setRefreshToken: async (token) => {
      if (token) await Keychain.setGenericPassword("refresh", token, { service: "chat-refresh" });
      else await Keychain.resetGenericPassword({ service: "chat-refresh" });
    },
  },
});
```

After a cold start, call `api.refresh()` once: it trades the stored refresh token for an
access token, or returns `null` when there is no session and the app should show sign-in.

## Streaming answers

Sending a message starts a turn on the server; the answer is generated there whether or not
anyone is listening ([ADR 0005](../architecture/adr/0005-turns-decoupled-via-redis-streams.md)).
React Native's built-in `fetch` cannot read a response body as it arrives, so do not use
`chats.sendStreaming` there. Instead:

1. `POST /api/chats/:id/messages` without `Accept: text/event-stream` (`api.chats.send(id, body)`,
   `id` may be `"new"`): it answers 202 `TurnStarted` with `turnId`, `conversationId`,
   `userMessageId` and `assistantMessageId`.
2. Follow the turn with `followTurn` over XHR, which exposes the growing response text in
   `onprogress` on every React Native version:

```ts
const started = await api.chats.send(conversationId ?? "new", { content, fileIds, webSearch });
let lastSeq = 0;
const controller = new AbortController();
for await (const ev of api.turns.follow(started.turnId, { transport: "xhr", after: lastSeq, signal: controller.signal })) {
  lastSeq = ev.seq;
  switch (ev.type) {
    case "message.delta": appendText(started.assistantMessageId, ev.text); break;
    case "tool.started": showStep(ev.label); break;
    case "tool.finished": finishStep(ev.label, ev.ok, ev.sources, ev.image); break;
    case "message.completed": replaceText(ev.messageId, ev.content, ev.sources); break;
    case "title": renameChat(ev.conversationId, ev.title); break;
    case "error": showError(ev.message); break; // safe to show; switch on ev.code
    case "done": markDone(ev.status); break;
  }
}
```

`followTurn` reconnects by itself with `?after=<last seq>` when the connection drops (up to
`maxRetries`, 8 by default, with backoff), skips anything it has already yielded, and returns
after `done`. Every event carries `seq`; persist the last one per turn.

### Resume on foreground

When the app goes to the background the OS suspends or kills the connection; the turn keeps
running. The server keeps every event of a turn for one hour after the last one.

- On `AppState` change to `background`, abort the controller (stop following, do not cancel
  the turn) and keep `turnId` and `lastSeq`.
- On `active`, call `api.turns.follow(turnId, { transport: "xhr", after: lastSeq })` again. You
  receive exactly the events you missed, in order, then the rest live.
- After a cold start, `GET /api/chats/:id` returns `activeTurnId` when an answer is still
  being written: follow it from `after: 0` and rebuild the answer from the events (the stored
  message stays empty until the turn ends).
- Later than an hour, or for a finished turn whose log expired, the same endpoint replays the
  final message as one `message.completed` and `done`, so the client code is the same.

### Stop

`POST /api/turns/:id/cancel` (`api.turns.cancel(turnId)`) stops the turn wherever it runs;
the partial answer is kept with status `CANCELLED` and the stream ends with
`done { status: "CANCELLED" }`.

### Edit and regenerate

Conversations are trees ([ADR 0006](../architecture/adr/0006-message-tree-for-branching.md)).
`POST /api/messages/:id/regenerate` makes a sibling answer; sending with `parentId` (the
answer before the question you edit, or `null` for the first question) makes a sibling
question. `Message.siblingIds` lists the versions for a `< 2/3 >` control and
`PUT /api/chats/:id/leaf { messageId }` switches the branch on screen.

## Uploads with progress

Files go straight to storage with a presigned URL; the app only ever handles file ids
([files.md](../architecture/files.md)):

```ts
const file = await api.files.upload({
  purpose: "ATTACHMENT",
  file: { uri, name: "photo.jpg", type: "image/jpeg" } as unknown as Blob, // or a real Blob
  onProgress: (fraction) => setProgress(fraction),
});
// file.status is READY: send its id
await api.chats.send(id, { content: "What is in this picture?", fileIds: [file.id] });
```

`uploadFile` asks for a ticket (`POST /api/files`), PUTs the bytes with the exact headers it
returned using XHR (`putWithProgress`, `xhr.upload.onprogress`), calls `complete` (which
checks the stored size and magic bytes), then polls until the file is `READY` (images are
re-encoded without EXIF, documents read) or throws `FILE_REJECTED` with the reason. In React
Native, make sure the object you pass has `size` and `name`, or call `putWithProgress` with
your own ticket. HEIC photos are accepted when the server's image library can decode them;
otherwise they are rejected with a message asking for JPEG, so convert to JPEG on the device
when you can.

Accepted types, the size limit and the files-per-message limit come from `GET /api/meta`
(`limits.acceptedMimeTypes`, `limits.maxFileMb`, `limits.maxFilesPerMessage`); a user's tier
may lower the size (`GET /api/me/usage` returns `maxFileMb`).

## Feature flags and forced updates

Call `GET /api/meta` (public, cached 30 s) at launch and on foreground:

| Field | Use |
| --- | --- |
| `appName`, `tagline`, `support.email` | Branding and the help screen |
| `registration` | `OPEN`, `INVITE_ONLY` or `CLOSED`: hide or explain sign-up |
| `features.webSearch`, `imageGeneration`, `dictation`, `readAloud`, `memory`, `projects`, `sharing` | Show only what the server can serve (a feature is true only when the admin turned it on and the backing provider or model exists) |
| `limits` | Composer limits: `maxMessageChars` (32,000), files and types |
| `minSupportedVersion` | `x.y.z` or null. When your app's version is lower, show a blocking "Update the app" screen with a store link before anything else |

Admins set `minSupportedVersion` in `/admin/settings` when a server change would break old
apps. `GET /api/models` gives the model picker with each model's `supportsVision`,
`supportsTools` and `supportsReasoning`; disable image attachments for models without vision
(the server answers `400 MODEL_NO_VISION` otherwise).

## Voice

| Feature | Call |
| --- | --- |
| Dictation | Record (m4a/AAC on iOS and Android is fine), then `POST /api/speech/transcribe?language=en` with the raw audio as the body and its `Content-Type` (`audio/mp4`, `audio/x-m4a`, `audio/webm`, `audio/ogg`, `audio/mpeg`, `audio/wav`), at most 25 MB. Answers `{ text }` to put in the composer. The bytes are sniffed; audio is never stored |
| Read aloud | `GET /api/messages/:id/speech` streams `audio/mpeg` with the user's voice preference. Play it with a player that accepts a URL plus an `Authorization` header, or download to a temp file first |

Both count against the daily allowance and answer `503 MODEL_UNAVAILABLE` when no
TRANSCRIBE or SPEECH model is configured. A ChatGPT-style live voice conversation is not part
of the API.

## Errors

Every non-2xx body is `{ error, code, details?, requestId }`. Switch on `code`, show `error`
when you have nothing better, and include `requestId` in bug reports. Turn failures arrive as
an `error` event with one of seven codes (`QUOTA_EXCEEDED`, `MODEL_UNAVAILABLE`,
`PROVIDER_ERROR`, `PROVIDER_RATE_LIMITED`, `CONTEXT_TOO_LONG`, `CONTENT_BLOCKED`, `INTERNAL`)
and a message that is safe to show. `429 RATE_LIMITED` carries `Retry-After`.

## Not there yet: push notifications

The API has no push support today: no device registration table, no FCM or APNs sender. A
long answer that finishes while the app is in the background is collected on the next
foreground through the resume flow above. Push ("your answer is ready", "your image is
done") is on the roadmap; it would register device tokens per session and send after a turn
completes, outside the turn's critical path. The route comment on `POST /api/auth/logout`
mentions a `deviceToken`; the current schema does not accept that field.

## A checklist

- `X-Client: native` on auth calls; refresh token in the keystore only.
- Vendored `packages/types` and `packages/api-client` at a pinned commit, with the drift check
  in CI.
- `send` (202) then `turns.follow(turnId, { transport: "xhr" })`; persist `lastSeq`; resume
  on foreground; follow `activeTurnId` after a cold start.
- Uploads through `files.upload` with `onProgress`; only file ids in messages.
- `GET /api/meta` at launch: features, limits, `minSupportedVersion`.
- Never log message text, tokens or file URLs (signed URLs expire, but still).
