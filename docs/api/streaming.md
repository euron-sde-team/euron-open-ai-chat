# Streaming turns

A **turn** is one assistant answer being generated on the server. This page is the client
contract for following one: the wire format, every event type with an example, resume and
reconnect, cancel, and working examples for curl, JavaScript and React Native. How it is
built on the server is in
[streaming-and-resume.md](../architecture/streaming-and-resume.md). The types are
[`packages/types/src/events.ts`](../../packages/types/src/events.ts); the reference reader
is [`packages/api-client/src/stream.ts`](../../packages/api-client/src/stream.ts).

## Starting a turn

| Request | Starts |
| --- | --- |
| `POST /api/chats/:id/messages` (`:id` may be `new`) | An answer to a new question ([rest-contract.md](rest-contract.md#chat-chatsroutests-messagesroutests-turnsroutests)) |
| `POST /api/messages/:id/regenerate` | A sibling answer to the same question |

Either way you choose how to receive it:

- **Stream on the same response**: send `Accept: text/event-stream`. The response is the
  event stream from the first event. The first event, `turn.started`, carries the ids you
  need to resume.
- **Fire and follow**: without that header the response is `202 TurnStarted`
  `{ turnId, conversationId, userMessageId, assistantMessageId }`; open
  `GET /api/turns/:turnId/events` to follow it.

The turn runs on the server whatever happens to the connection. Closing the response stops
your view of the turn, not the turn ([ADR 0005](../architecture/adr/0005-turns-decoupled-via-redis-streams.md)).

## Wire format

Server-Sent Events. Response headers: `Content-Type: text/event-stream; charset=utf-8`,
`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. The stream starts with a
reconnection hint, then one block per event, each terminated by a blank line:

```
retry: 2000

id: 1
event: turn.started
data: {"seq":1,"type":"turn.started","turnId":"01JDXQ4M2B...","conversationId":"01JDXQ4M1Z...","userMessageId":"01JDXQ4M2A...","assistantMessageId":"01JDXQ4M2B...","model":{"id":"01JDK4V7Q8...","displayName":"Stub Pro"}}

id: 2
event: message.delta
data: {"seq":2,"type":"message.delta","text":"Here is"}

: keep-alive

```

- `id` equals the event's `seq`; `event` equals its `type`; `data` is the whole event as one
  line of JSON (it repeats `seq` and `type`, so you can ignore the SSE fields and parse
  `data` alone).
- Lines starting with `:` are comments; one is sent every 15 seconds to keep proxies from
  closing an idle connection. Ignore them.
- The stream ends after the `done` event. The server then closes the response.

## Event catalogue

Every event has `seq` (1, 2, 3, ... per turn) and `type`. Events arrive in order. The
examples show the `data` payload.

### `turn.started`

Always first. The ids for this turn, and the model that is answering.

```json
{
  "seq": 1,
  "type": "turn.started",
  "turnId": "01JDXQ4M2B6V7W8X9Y0Z1A2B3C",
  "conversationId": "01JDXQ4M1ZQ5R6S7T8U9V0W1X2",
  "userMessageId": "01JDXQ4M2A4N5P6Q7R8S9T0U1V",
  "assistantMessageId": "01JDXQ4M2B6V7W8X9Y0Z1A2B3C",
  "model": { "id": "01JDK4V7Q8A0B1C2D3E4F5G6H7", "displayName": "Stub Pro" }
}
```

`userMessageId` is `null` for a regeneration. `turnId` always equals `assistantMessageId`.

### `message.delta`

A piece of the answer, Markdown. Append in order. Deltas are coalesced on the server (about
every 40 ms or 96 characters), so there are far fewer events than tokens.

```json
{ "seq": 6, "type": "message.delta", "text": "The latest release adds streaming tool calls [1] and " }
```

### `reasoning.delta`

A piece of the model's visible reasoning summary, for models that stream one. Show it in a
collapsible "thinking" area, not in the answer.

```json
{ "seq": 3, "type": "reasoning.delta", "text": "The user wants a comparison, so I should search first." }
```

### `tool.started`

The assistant began a tool call. `label` is ready to show ("Searching the web for ...").
`callId` pairs it with its `tool.finished`.

```json
{
  "seq": 4,
  "type": "tool.started",
  "callId": "call_9f2c",
  "tool": "web_search",
  "label": "Searching the web for \"open source chat release notes\""
}
```

`tool` is one of `web_search`, `open_url`, `generate_image`, `remember`,
`search_project_files`.

### `tool.finished`

The tool call ended. `ok: false` means it failed (the model is told and usually explains);
the turn goes on. `web_search` and `open_url` add the new sources, numbered for citations;
`generate_image` adds the image, ready to show.

```json
{
  "seq": 5,
  "type": "tool.finished",
  "callId": "call_9f2c",
  "tool": "web_search",
  "label": "Found 3 results for \"open source chat release notes\"",
  "ok": true,
  "sources": [
    {
      "n": 1,
      "title": "Release notes",
      "url": "https://docs.example.com/releases",
      "domain": "docs.example.com",
      "snippet": "Version 2 adds streaming tool calls and ...",
      "publishedAt": "2026-10-01"
    },
    {
      "n": 2,
      "title": "Changelog",
      "url": "https://example.com/changelog",
      "domain": "example.com",
      "snippet": "Fixed resume after reconnect ...",
      "publishedAt": null
    }
  ]
}
```

With an image:

```json
{
  "seq": 9,
  "type": "tool.finished",
  "callId": "call_a71e",
  "tool": "generate_image",
  "label": "Created an image",
  "ok": true,
  "image": {
    "id": "01JDXQ5B7C8D9E0F1G2H3J4K5M",
    "purpose": "GENERATED",
    "kind": "IMAGE",
    "mimeType": "image/png",
    "fileName": "image-2026-10-27.png",
    "sizeBytes": 412034,
    "width": 1024,
    "height": 1024,
    "pageCount": null,
    "status": "READY",
    "rejectedReason": null,
    "url": "https://media.example.com/generated/01JDXQ5B7C.png?X-Amz-Signature=...",
    "thumbUrl": "https://media.example.com/generated/01JDXQ5B7C.png.thumb.webp?X-Amz-Signature=...",
    "createdAt": "2026-10-27T09:14:03.512Z"
  }
}
```

A failure:

```json
{ "seq": 7, "type": "tool.finished", "callId": "call_b3d0", "tool": "open_url", "label": "Could not read intranet.example.com", "ok": false }
```

Image URLs are signed and expire after about 15 minutes; refetch the conversation for
fresh ones.

### `message.completed`

The finished answer. **Replace** what you assembled from deltas with `content`: it is the
stored text, so a client that joined late or missed a delta ends up correct.

```json
{
  "seq": 14,
  "type": "message.completed",
  "messageId": "01JDXQ4M2B6V7W8X9Y0Z1A2B3C",
  "content": "The latest release adds streaming tool calls [1] and fixes resume after reconnect [2].",
  "sources": [
    { "n": 1, "title": "Release notes", "url": "https://docs.example.com/releases", "domain": "docs.example.com", "snippet": "Version 2 adds ...", "publishedAt": "2026-10-01" },
    { "n": 2, "title": "Changelog", "url": "https://example.com/changelog", "domain": "example.com", "snippet": "Fixed resume ...", "publishedAt": null }
  ],
  "finishReason": "stop"
}
```

`finishReason` is `stop`, `length` (the model hit its output limit), `content_filter` or
`other`. Citations in the text are `[n]` and refer to `sources[n]`.

### `usage`

Tokens this turn used, and what they counted against today's allowance.

```json
{ "seq": 15, "type": "usage", "inputTokens": 1830, "outputTokens": 412, "weightedTokens": 2242 }
```

### `title`

A new automatic title, after a conversation's first answer (never after a rename).

```json
{ "seq": 16, "type": "title", "conversationId": "01JDXQ4M1ZQ5R6S7T8U9V0W1X2", "title": "Release notes comparison" }
```

### `error`

The turn failed. `message` is safe to show as is; it never contains provider text. An
`error` is always followed by `done` with `FAILED`. A cancel produces no `error`.

```json
{ "seq": 8, "type": "error", "code": "PROVIDER_RATE_LIMITED", "message": "The model provider is busy. Try again in a moment." }
```

### `done`

Always the last event. The stream closes after it.

```json
{ "seq": 17, "type": "done", "status": "COMPLETE" }
```

`status` is `COMPLETE`, `CANCELLED` (partial answer kept) or `FAILED`.

### Typical orders

| Turn | Events |
| --- | --- |
| Plain answer | `turn.started`, `message.delta` x N, `message.completed`, `usage`, (`title`), `done` |
| With search | `turn.started`, `tool.started`, `tool.finished` (sources), `message.delta` x N, `message.completed`, `usage`, `done` |
| Image mode | `turn.started`, `tool.started` (`generate_image`), `tool.finished` (image), `message.completed` (empty content), `usage` (zero tokens), (`title`), `done` |
| Failure | `turn.started`, ... `error`, `done` `FAILED` |
| Cancelled | `turn.started`, ... `done` `CANCELLED` |

## Error codes inside a turn

| `code` | Meaning | Suggested client action |
| --- | --- | --- |
| `QUOTA_EXCEEDED` | Today's allowance is used up | Show the reset time from `GET /api/me/usage` |
| `MODEL_UNAVAILABLE` | The model's key was rejected or no image model exists | Offer another model |
| `PROVIDER_ERROR` | The provider failed, timed out or was unreachable | Offer retry (regenerate) |
| `PROVIDER_RATE_LIMITED` | The provider is rate limiting the deployment | Offer retry later |
| `CONTEXT_TOO_LONG` | The conversation no longer fits the model | Suggest a new chat or fewer attachments |
| `CONTENT_BLOCKED` | Moderation or the provider refused | Show the message |
| `INTERNAL` | Anything else (including a turn failed by the server's sweep) | Offer retry |

## Resume semantics

- **Keep the last `seq` you applied.** To resume, open
  `GET /api/turns/:turnId/events?after=<seq>`. You get every later event and none you have
  seen. `Last-Event-ID: <seq>` works the same (browsers' `EventSource` sends it on its own);
  `?after=` wins when both are present.
- **Duplicates are harmless.** Ignore any event with `seq <= lastSeq`.
- **One hour.** The server keeps a turn's events for an hour after its last event. After
  that, a resume returns the stored answer as one `message.completed` (when it completed)
  and `done`, numbered after your `after`.
- **Any server.** Resume works against any API task.
- **After a reload or app restart**, `GET /api/chats/:id` returns `activeTurnId` while an
  answer is still being written. Clear what you showed for that answer and follow from
  `after=0`; the replay rebuilds it.
- **Finished turns.** Following a turn that ended long ago returns
  `message.completed` (or nothing, for a failed turn) and `done`.

## Reconnect algorithm

What `followTurn` does, and what any client should do:

```
after = lastAppliedSeq (0 for a new turn)
failures = 0
loop until done or the user leaves:
  open GET /api/turns/:id/events?after=<after>
  for each event:
    failures = 0
    if event.seq <= after: skip
    apply(event); after = event.seq
    if event.type == "done": stop
  # the stream ended without done (a deploy restarted the task), or the request failed:
  if the failure is an HTTP 4xx other than 408 and 429: stop and surface it
    (401: refresh the access token first, then reconnect)
  failures += 1; if failures > 8: give up and surface "connection lost"
  wait min(8 s, 400 ms * 2^failures)
```

On mobile, also reconnect when the app returns to the foreground, from the saved `after`.
If the stream stays silent (no event and no keep-alive comment) for much longer than 15 s,
treat it as dropped.

## Cancel

```
POST /api/turns/:turnId/cancel     ->  204
```

The server aborts the provider call and any running tool, stores the partial answer as
`CANCELLED`, and the stream ends with `done` `CANCELLED`. Cancelling a finished turn is a
no-op. Keep following until `done` so you see the final state. Deleting the conversation
also cancels its running turn.

## curl

```bash
API=http://localhost:5036/api
TOKEN=$(curl -s $API/auth/login -H 'Content-Type: application/json' \
  -d '{"login":"priya.nair@example.com","password":"<demo password>"}' | jq -r .accessToken)

# Send and stream on the same response (-N: no buffering)
curl -N $API/chats/new/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"content":"Search the latest news about open source models","webSearch":true}'

# Or fire and follow
TURN=$(curl -s $API/chats/new/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content":"Write a slow haiku"}' | jq -r .turnId)
curl -N "$API/turns/$TURN/events?after=0" -H "Authorization: Bearer $TOKEN"

# Drop the connection (Ctrl-C) after, say, seq 5, then resume
curl -N "$API/turns/$TURN/events?after=5" -H "Authorization: Bearer $TOKEN"

# Stop it
curl -s -X POST "$API/turns/$TURN/cancel" -H "Authorization: Bearer $TOKEN" -o /dev/null -w '%{http_code}\n'
```

Against the local stack with the Stub provider, the word "slow" in a message makes the
stub stream slowly, which is handy for trying resume and cancel
([testing.md](../guides/testing.md)).

## JavaScript (browser or Node)

```ts
import { createApiClient, followTurn } from "@open-chat/api-client";

let accessToken: string | null = null;
const api = createApiClient({
  baseUrl: "https://chat.example.com/api",
  getAccessToken: () => accessToken,
  onRefresh: (r) => (accessToken = r.accessToken),
});

async function ask(question: string, onText: (text: string) => void) {
  const started = await api.chats.send("new", { content: question, webSearch: true });
  let text = "";
  let lastSeq = 0;
  for await (const ev of followTurn(api.http, started.turnId, { after: lastSeq })) {
    lastSeq = ev.seq; // persist this if the page may reload
    switch (ev.type) {
      case "message.delta":
        text += ev.text;
        onText(text);
        break;
      case "message.completed":
        text = ev.content; // replace with the stored answer
        onText(text);
        break;
      case "error":
        console.warn(ev.code, ev.message);
        break;
      case "done":
        return { status: ev.status, conversationId: started.conversationId, text };
    }
  }
}

// Stop: await api.turns.cancel(turnId)
```

`followTurn` reconnects by itself with `?after=` through dropped connections. To stream on
the send response instead, use `api.chats.sendStreaming(id, body, signal)` and, if it
breaks, continue with `followTurn(api.http, turnId, { after: lastSeq })` as the web app
does ([`apps/web/src/lib/chat/turn-runner.ts`](../../apps/web/src/lib/chat/turn-runner.ts)).

## React Native

React Native's built-in `fetch` cannot read a response body as a stream, so pass
`transport: "xhr"`: the reader parses `XMLHttpRequest.responseText` as it grows. Native
apps sign in with `X-Client: native` and keep the refresh token in the keystore
([mobile-clients.md](../guides/mobile-clients.md)).

```tsx
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { createApiClient, followTurn } from "@open-chat/api-client";
import { session } from "./session"; // your keystore-backed token holder

const api = createApiClient({
  baseUrl: "https://chat.example.com/api",
  getAccessToken: () => session.accessToken,
  onRefresh: (r) => session.setAccessToken(r.accessToken),
});

export function useTurn(turnId: string | null) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"STREAMING" | "COMPLETE" | "CANCELLED" | "FAILED">("STREAMING");
  const lastSeq = useRef(0);
  const finished = useRef(false);

  useEffect(() => {
    if (!turnId) return;
    let controller = new AbortController();

    const run = async () => {
      try {
        for await (const ev of followTurn(api.http, turnId, { after: lastSeq.current, transport: "xhr", signal: controller.signal })) {
          lastSeq.current = ev.seq;
          if (ev.type === "message.delta") setText((t) => t + ev.text);
          else if (ev.type === "message.completed") setText(ev.content);
          else if (ev.type === "done") {
            finished.current = true;
            setStatus(ev.status);
          }
        }
      } catch {
        // followTurn already retried; leave the partial text and let the user pull to refresh
      }
    };
    void run();

    // The OS suspends sockets in the background: drop the stream there, resume on return.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && !finished.current) {
        controller.abort();
        controller = new AbortController();
        void run();
      } else if (state === "background") {
        controller.abort();
      }
    });
    return () => {
      sub.remove();
      controller.abort();
    };
  }, [turnId]);

  return { text, status, stop: () => turnId && api.turns.cancel(turnId) };
}
```

The answer keeps being written while the app is in the background; on return the hook
resumes from `lastSeq.current` and collects everything it missed (within the hour). Never
reopen a stream after you have seen `done`: there is nothing more to read, and the request
would wait for events that will not come.
