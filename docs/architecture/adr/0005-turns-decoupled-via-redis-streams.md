# ADR 0005: Turns decoupled from connections through Redis Streams

## Status

Accepted.

## Context

An answer can take a minute: several model rounds, web searches, page reads, an image.
Phones go to the background, trains enter tunnels, laptops sleep, deploys restart tasks.
If the answer lived only on the HTTP response that asked for it, any of those would lose
it, and a cancel would only work on the task holding the connection. Behind a load
balancer the client that reconnects can land on any API task.

## Decision

- A send stores the question and an empty `STREAMING` answer in one transaction, then
  starts the turn with `startTurn` without awaiting it
  ([`services/chat/chat.service.ts`](../../../apps/api/src/services/chat/chat.service.ts),
  [`services/chat/turns.ts`](../../../apps/api/src/services/chat/turns.ts)). The answer's
  message id is the turn id. Closing the connection does not stop the turn.
- Every event is appended to the Redis Stream `turn:<id>:events` under the explicit id
  `0-<seq>` and announced on the pub/sub channel `turn:<id>`; the stream expires an hour
  after its last write ([`services/chat/event-log.ts`](../../../apps/api/src/services/chat/event-log.ts)).
- A follower subscribes first, then reads what is already in the stream, then follows
  announcements, so it joins at any point and sees nothing twice. Any task can serve
  `GET /api/turns/:id/events?after=<seq>` (or `Last-Event-ID`).
- After the stream expires, the finished message is replayed from Postgres as a final
  `message.completed` and `done`.
- Cancel sets `turn:<id>:cancel` and publishes on `turn:<id>:cancel`; the task running the
  turn aborts its provider call. The partial answer is kept as `CANCELLED`.
- `maintenance.sweep-turns` (every 2 minutes) fails answers left `STREAMING` for more than
  15 minutes, so a turn whose task died does not block its conversation
  ([`jobs/maintenance.jobs.ts`](../../../apps/api/src/jobs/maintenance.jobs.ts)).
- Text deltas are coalesced (about every 40 ms or 96 characters) to keep the stream small.

## Consequences

Positive:

- Resume is exact: `followTurn` in `@open-chat/api-client` reconnects with the last seq
  and the web app, a reload or a phone returning to the foreground picks up mid-answer
  ([streaming.md](../../api/streaming.md), [streaming-and-resume.md](../streaming-and-resume.md)).
- No sticky sessions; any task serves any follower.
- One conversation has at most one running turn (`409 TURN_IN_PROGRESS`).

Trade-offs:

- The turn runs inside the API task that accepted it; a crash ends it as `FAILED`
  (after the sweep), it is not restarted elsewhere.
- Redis becomes required for chat; its memory holds an hour of events per turn.
- A turn that is slower than 15 minutes would be swept; the per-call provider timeout is
  180 seconds and rounds are capped, so this does not happen in practice.

## Alternatives considered

- **Streaming only on the request.** Simple, loses answers on every dropped connection.
- **Running turns in the worker through BullMQ.** Adds queue latency to the first token
  and still needs an event log for followers.
- **WebSockets.** A second protocol and stateful connections to balance; SSE over plain
  HTTP works through every proxy and on React Native with XHR.
