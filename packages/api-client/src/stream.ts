/**
 * Reading a turn's event stream (docs/api/streaming.md) from any JavaScript runtime.
 *
 * `followTurn` opens GET /turns/:id/events and yields typed TurnEvents in order until
 * `done`. When the connection drops (a tunnel, a phone going to the background, a deploy
 * restarting the task) it reconnects with `?after=<last seq>` and carries on: the server
 * keeps every event of a turn for an hour, so nothing is lost and nothing repeats.
 *
 * Transport: `fetch` with a readable body (browsers, Node, Expo with streaming fetch).
 * React Native's built-in fetch cannot stream, so pass `transport: "xhr"` there: the
 * response text is read as it grows (onprogress), which every RN version supports.
 */
import type { TurnEvent } from "@open-chat/types";
import { ApiError, toApiError } from "./errors";
import type { HttpClient } from "./http";

export interface FollowOptions {
  /** Resume after this sequence number (0 = from the start). */
  after?: number;
  signal?: AbortSignal;
  /** fetch (default) or xhr for React Native. */
  transport?: "fetch" | "xhr";
  /** Reconnect attempts after a dropped connection before giving up. */
  maxRetries?: number;
}

/** Parse SSE text: complete events are returned, the unfinished tail is kept for the next chunk. */
export function parseSseChunk(buffer: string): { events: TurnEvent[]; rest: string } {
  const events: TurnEvent[] = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as TurnEvent);
    } catch {
      // A malformed block is skipped; the next one carries on.
    }
  }
  return { events, rest };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/** Follow a turn to its end, reconnecting as needed. */
export async function* followTurn(http: HttpClient, turnId: string, opts: FollowOptions = {}): AsyncGenerator<TurnEvent> {
  let after = opts.after ?? 0;
  let failures = 0;
  const max = opts.maxRetries ?? 8;
  while (!opts.signal?.aborted) {
    try {
      const source = opts.transport === "xhr" ? xhrEvents(http, turnId, after, opts.signal) : fetchEvents(http, turnId, after, opts.signal);
      for await (const ev of source) {
        failures = 0;
        if (ev.seq <= after) continue;
        after = ev.seq;
        yield ev;
        if (ev.type === "done") return;
      }
      // The server closed the stream without `done` (a restart): reconnect.
    } catch (err) {
      if (opts.signal?.aborted) return;
      // 4xx other than a stale token will not get better by retrying.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) throw err;
      if (++failures > max) throw err;
    }
    await sleep(Math.min(8000, 400 * 2 ** failures), opts.signal);
  }
}

async function* fetchEvents(http: HttpClient, turnId: string, after: number, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  const res = await http.request<Response>("GET", `/turns/${encodeURIComponent(turnId)}/events`, { query: { after }, raw: true, signal, headers: { Accept: "text/event-stream" } });
  yield* readEventStream(res, signal);
}

/** Yield the TurnEvents of an SSE response body (a send with Accept: text/event-stream returns one). */
export async function* readEventStream(res: Response, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  if (!res.ok) throw toApiError(res.status, await res.json().catch(() => undefined));
  if (!res.body) throw new ApiError({ status: 0, message: "This runtime cannot stream responses; use transport: \"xhr\"", code: "STREAM_UNSUPPORTED" });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;
      for (const ev of parsed.events) yield ev;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** React Native: XHR exposes the growing response text; parse the new part on every progress event. */
function xhrEvents(http: HttpClient, turnId: string, after: number, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  const queue: TurnEvent[] = [];
  let finished = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const xhr = new XMLHttpRequest();
  let seen = 0;
  let buffer = "";
  const start = async () => {
    const token = await http.currentToken();
    xhr.open("GET", http.url(`/turns/${encodeURIComponent(turnId)}/events`, { after }));
    xhr.setRequestHeader("Accept", "text/event-stream");
    if (http.isNative) xhr.setRequestHeader("X-Client", "native");
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    const drain = () => {
      buffer += xhr.responseText.slice(seen);
      seen = xhr.responseText.length;
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;
      queue.push(...parsed.events);
      notify();
    };
    xhr.onprogress = drain;
    xhr.onload = () => {
      if (xhr.status >= 400) failure = toApiError(xhr.status, safeJson(xhr.responseText));
      else drain();
      finished = true;
      notify();
    };
    xhr.onerror = () => {
      failure = new ApiError({ status: 0, message: "Network error", code: "NETWORK_ERROR" });
      finished = true;
      notify();
    };
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send();
  };
  void start();
  return (async function* () {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (failure) throw failure;
      if (finished) return;
      await new Promise<void>((r) => (wake = r));
    }
  })();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
