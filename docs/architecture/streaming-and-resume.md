# Streaming and resume

How a turn's events get from the task generating them to any number of clients, across
dropped connections, other API tasks and app restarts, and how a cancel reaches the turn
wherever it runs. The wire format and the event catalogue for client authors are in
[docs/api/streaming.md](../api/streaming.md); the decision is
[ADR 0005](adr/0005-turns-decoupled-via-redis-streams.md). Paths are relative to the
repository root.

![A turn: the send stores the question and a STREAMING answer, the turn runs detached, events go to a Redis Stream with sequence ids and a pub/sub wakeup, any task's SSE subscriber follows, the client resumes with after=seq, cancel goes through Redis, and the sweep fails orphaned turns](../assets/diagrams/turn-streaming.svg)

## 1. The problem it solves

When an answer is generated inside the HTTP request that asked for it, a phone going to
the background, a train tunnel, a proxy timeout or a deploy kills the answer half way, and
a reload shows nothing until the user asks again. A chat client must survive all of
those: the answer keeps being written on the server, and any client, on any connection,
can pick it up where it left off.

## 2. The pieces

| Piece | Where | Does |
| --- | --- | --- |
| `startTurn` / `runTurn` | [`apps/api/src/services/chat/turns.ts`](../../apps/api/src/services/chat/turns.ts) | Runs the turn as a detached promise in the accepting task; errors are handled inside |
| `TurnWriter` | [`apps/api/src/services/chat/event-log.ts`](../../apps/api/src/services/chat/event-log.ts) | Numbers events and appends them to the turn's Redis Stream, then announces them |
| `follow` | same | An async generator: every event after a sequence number, in order, until `done` |
| `requestCancel` / `onCancel` | same | A cancel flag plus a pub/sub message that aborts the turn's `AbortController` |
| `openSse` / `resumeAfter` | [`apps/api/src/middleware/sse.ts`](../../apps/api/src/middleware/sse.ts) | SSE headers, keep-alive, disconnect handling, the resume point |
| `turnEvents` | [`apps/api/src/services/chat/chat.service.ts`](../../apps/api/src/services/chat/chat.service.ts) | Ownership check, then the live log or a replay from Postgres |
| `followTurn` | [`packages/api-client/src/stream.ts`](../../packages/api-client/src/stream.ts) | The client side: reconnect with `?after=` until `done`, over fetch or XHR |
| Turn runner | [`apps/web/src/lib/chat/turn-runner.ts`](../../apps/web/src/lib/chat/turn-runner.ts) | The web app: optimistic messages, events into the React Query cache, resume on reload |
| `maintenance.sweep-turns` | [`apps/api/src/jobs/maintenance.jobs.ts`](../../apps/api/src/jobs/maintenance.jobs.ts) | Fails turns whose task died |

## 3. The event log in Redis

| Key | Type | Content | Lifetime |
| --- | --- | --- | --- |
| `turn:<id>:events` | Stream | One entry per event, id `0-<seq>`, field `e` = the event JSON (including `seq`) | `EXPIRE` 3600 s, renewed on every append |
| `turn:<id>` | pub/sub channel | The new `seq`, as a wakeup | n/a |
| `turn:<id>:cancel` | string | `"1"` when someone pressed stop | 3600 s |
| `turn:<id>:cancel` | pub/sub channel | `"1"` | n/a |

`TurnWriter.emit` does one `MULTI`: `XADD turn:<id>:events 0-<seq> e <json>`,
`EXPIRE ... 3600`, `PUBLISH turn:<id> <seq>`. There is exactly one writer per turn (the
task running it), so the counter is a plain field and the explicit stream ids are
monotonic. Using the sequence number as the stream id makes "everything after N" a single
`XRANGE turn:<id>:events 0-<N+1> +`.

## 4. Following a turn

`follow(turnId, after, stop)` is careful about ordering so a subscriber that joins at any
moment misses nothing and sees nothing twice:

1. **Subscribe first** to `turn:<id>` (one shared subscriber connection per process; a
   listener set per channel).
2. **Then read** everything already in the stream after `after` and yield it.
3. **Then wait** for a wakeup. Each wakeup sets a `pending` flag; the loop re-reads from the
   last seq it yielded. Events that arrive between the read and the wait are covered by
   the flag, because the subscription was already in place.
4. **Return** after yielding `done`, or when `stop` aborts (the client went away; the turn
   goes on).
5. **Idle timeout** (120 s without a wakeup): if the stream key no longer exists (expired,
   or the task died long ago) the generator returns; otherwise it re-reads, which also
   covers a missed pub/sub message.

## 5. The two entry points

| Request | Behaviour |
| --- | --- |
| `POST /api/chats/:id/messages` or `POST /api/messages/:id/regenerate` with `Accept: text/event-stream` | Accepts the send, then streams the new turn from seq 0 on the same response |
| The same without that header | `202 TurnStarted` (`turnId`, `conversationId`, `userMessageId`, `assistantMessageId`); the client follows separately |
| `GET /api/turns/:id/events?after=<seq>` (or the `Last-Event-ID` header) | Ownership checked before the stream opens (a stranger's id is a plain 404), then `turnEvents` |

`turnEvents(actor, turnId, after)`:

- **The log exists**: follow it from `after`.
- **No log yet but the row is `STREAMING`**: the send was accepted moments ago and the
  first event is not written; follow anyway with a 15 s idle timeout.
- **No log and the row is final** (the log expired after an hour, or Redis was flushed):
  replay from Postgres: a `message.completed` with the stored content and sources (when
  `COMPLETE`), then `done` with the stored status (a row still `STREAMING` with no log is
  reported `FAILED`). Sequence numbers continue from `after`, so a client that saw part of
  the live stream still gets a coherent ending.

## 6. SSE on the wire

`openSse` sets `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
`Connection: keep-alive` and `X-Accel-Buffering: no` (nginx does not buffer), flushes the
headers, writes `retry: 2000`, and then one block per event:

```
id: 7
event: message.delta
data: {"seq":7,"type":"message.delta","text":"Hel"}

```

A `: keep-alive` comment every 15 s keeps idle connections open through load balancers
(the AWS ALB idle timeout is also raised to 300 s, `alb_idle_timeout` in
[`infra/terraform/modules/deployment/main.tf`](../../infra/terraform/modules/deployment/main.tf)).
When the client closes the connection, `signal` aborts and `follow` returns. The turn is
not affected.

Because the browser's `EventSource` sends `Last-Event-ID` on its automatic reconnect,
`resumeAfter` honours that header when `?after=` is absent. `?after=` wins when both are
present. Values outside `0..999999` are treated as 0.

## 7. Resume semantics

- **Exactly once, in order.** Every event has a `seq` starting at 1 and increasing by one.
  A client keeps the last `seq` it applied and resumes with `?after=<that>`; the server
  returns only later events. `followTurn` also skips any `seq <= after` it receives, so a
  duplicated chunk is harmless.
- **One hour.** The stream lives 3600 s after its last append. A client back within the
  hour replays every missed delta; later, it gets the stored answer as one
  `message.completed`.
- **Replace on completion.** `message.completed` carries the full content: clients replace
  what they assembled from deltas, so a client that joined late or skipped deltas ends up
  with exactly the stored text.
- **Any task.** The log is in Redis, so the resume can land on any API task.
- **Reload mid-answer.** `GET /api/chats/:id` returns `activeTurnId` while an answer is
  `STREAMING`; the web app's `resume()` clears the placeholder and replays from seq 0.

The client's reconnect algorithm (backoff, which errors are final, the XHR transport for
React Native) is in [streaming.md](../api/streaming.md#reconnect-algorithm).

## 8. Cancel

`POST /api/turns/:id/cancel` (owner only; a no-op when the turn is no longer streaming)
calls `requestCancel`: `SET turn:<id>:cancel 1 EX 3600` and `PUBLISH turn:<id>:cancel 1`
in one `MULTI`. The task running the turn subscribed to that channel when the turn
started (`onCancel`) and also checks the flag once at subscription time, so a cancel that
races the start is not lost. The listener aborts the turn's `AbortController`; the
provider fetch and any running tool see the abort; the turn stores the partial answer as
`CANCELLED` and emits `done` with `CANCELLED` (no `error` event). Deleting a conversation
cancels its running turn the same way.

## 9. When a task dies

If the API task running a turn crashes or is stopped mid-turn, nothing writes `done`. The
answer row stays `STREAMING` and followers time out. `maintenance.sweep-turns` runs every
2 minutes and marks every `STREAMING` message created more than 15 minutes ago as
`FAILED` with `error_code = 'INTERNAL'`, after which the conversation accepts new sends
(`TURN_IN_PROGRESS` only looks for `STREAMING` rows) and a follower gets the stored
`FAILED` ending from Postgres. The sweep uses the message's `created_at`; there is no
heartbeat, so an unusually long turn would also be cut at 15 minutes (each provider call
is capped at 180 s and a turn makes at most four, so a healthy turn ends well before).

On a deploy, `SIGTERM` stops the HTTP server from accepting connections and waits for open
requests, with a 25 s hard exit ([`apps/api/src/index.ts`](../../apps/api/src/index.ts)).
Open SSE responses count as open requests, and a detached turn is not awaited, so a turn
still running at the hard exit is left to the sweep.

## 10. Cost and limits

| Concern | Bound |
| --- | --- |
| Events per turn | Deltas are coalesced (about 40 ms or 96 characters each), so a long answer is hundreds of entries, not thousands |
| Memory in Redis | One stream per turn for an hour after its last event |
| Subscriber connections | One per API process, shared by every followed turn and every cancel listener |
| Followers per turn | Unlimited; each is an `XRANGE` per wakeup |
| Concurrent turns per conversation | One (`409 TURN_IN_PROGRESS`) |
