/**
 * The turn event log (ADR 0005). Every event of a turn is appended to a Redis Stream
 * `turn:<id>:events` under the explicit id `0-<seq>`, then announced on the pub/sub
 * channel `turn:<id>`. A subscriber (an SSE response, on any API task) subscribes first,
 * then reads what is already in the stream, then follows announcements, so it can join at
 * any point (or rejoin after a dropped connection with ?after=<seq>) and miss nothing and
 * see nothing twice.
 *
 * The stream outlives the turn by RETAIN_SECONDS so a phone that comes back from the
 * background can still collect the ending. After that the finished message is in Postgres.
 */
import type { TurnEvent, TurnEventInput } from "@open-chat/types";
import type { Redis } from "ioredis";
import { captureError } from "../../core/logger";
import { newSubscriberClient, redis } from "../../integrations/redis";

export const RETAIN_SECONDS = 3600;
const streamKey = (turnId: string) => `turn:${turnId}:events`;
const channel = (turnId: string) => `turn:${turnId}`;
const cancelKey = (turnId: string) => `turn:${turnId}:cancel`;

/** Writes one turn's events, numbering them. One writer per turn (the task running it). */
export class TurnWriter {
  private seq = 0;
  constructor(readonly turnId: string) {}

  async emit(event: TurnEventInput): Promise<TurnEvent> {
    const full = { ...event, seq: ++this.seq } as TurnEvent;
    const r = redis();
    await r.multi().xadd(streamKey(this.turnId), `0-${full.seq}`, "e", JSON.stringify(full)).expire(streamKey(this.turnId), RETAIN_SECONDS).publish(channel(this.turnId), String(full.seq)).exec();
    return full;
  }
}

/** Events with seq > after, already in the stream. */
export async function readAfter(turnId: string, after: number): Promise<TurnEvent[]> {
  const rows = await redis().xrange(streamKey(turnId), `0-${after + 1}`, "+");
  return rows.map(([, fields]) => JSON.parse(fields[1] ?? "{}") as TurnEvent);
}

export async function hasLog(turnId: string): Promise<boolean> {
  return (await redis().exists(streamKey(turnId))) === 1;
}

// ─── Subscriptions (one subscriber connection per process) ─────────────────

let sub: Redis | null = null;
const listeners = new Map<string, Set<() => void>>();

function subscriber(): Redis {
  if (!sub) {
    sub = newSubscriberClient();
    sub.on("error", (err) => captureError(err, { where: "event-log.subscriber" }));
    sub.on("message", (ch: string) => {
      for (const fn of listeners.get(ch) ?? []) fn();
    });
  }
  return sub;
}

async function listen(ch: string, fn: () => void): Promise<() => Promise<void>> {
  let set = listeners.get(ch);
  if (!set) {
    set = new Set();
    listeners.set(ch, set);
    await subscriber().subscribe(ch);
  }
  set.add(fn);
  return async () => {
    const s = listeners.get(ch);
    if (!s) return;
    s.delete(fn);
    if (!s.size) {
      listeners.delete(ch);
      await subscriber()
        .unsubscribe(ch)
        .catch((err) => captureError(err, { where: "event-log.unsubscribe" }));
    }
  };
}

/**
 * Follow a turn from `after`: yields every later event in order and returns after `done`.
 * `stop` ends the iteration early (the client went away); the turn itself goes on.
 */
export async function* follow(turnId: string, after: number, stop: AbortSignal, idleTimeoutMs = 120_000): AsyncGenerator<TurnEvent> {
  let wake: (() => void) | null = null;
  let pending = true;
  const off = await listen(channel(turnId), () => {
    pending = true;
    wake?.();
  });
  const onStop = () => wake?.();
  stop.addEventListener("abort", onStop);
  let last = after;
  try {
    while (!stop.aborted) {
      if (pending) {
        pending = false;
        for (const ev of await readAfter(turnId, last)) {
          last = ev.seq;
          yield ev;
          if (ev.type === "done") return;
        }
        continue;
      }
      const timedOut = await new Promise<boolean>((resolve) => {
        if (pending || stop.aborted) return resolve(false);
        const t = setTimeout(() => resolve(true), idleTimeoutMs);
        wake = () => {
          clearTimeout(t);
          resolve(false);
        };
      });
      wake = null;
      if (timedOut) {
        // Nothing for a long time: either the stream expired or the turn's task died.
        if (!(await hasLog(turnId))) return;
        pending = true;
      }
    }
  } finally {
    stop.removeEventListener("abort", onStop);
    await off();
  }
}

// ─── Cancellation ───────────────────────────────────────────────────────────

/** Ask a running turn to stop, wherever it runs. */
export async function requestCancel(turnId: string): Promise<void> {
  await redis().multi().set(cancelKey(turnId), "1", "EX", RETAIN_SECONDS).publish(`${channel(turnId)}:cancel`, "1").exec();
}

/** Abort `controller` when someone cancels this turn. Returns the unsubscribe function. */
export async function onCancel(turnId: string, controller: AbortController): Promise<() => Promise<void>> {
  const off = await listen(`${channel(turnId)}:cancel`, () => controller.abort(new DOMException("cancelled", "AbortError")));
  if (await redis().exists(cancelKey(turnId))) controller.abort(new DOMException("cancelled", "AbortError"));
  return off;
}

export async function closeEventLog(): Promise<void> {
  listeners.clear();
  if (sub) await sub.quit().catch(() => undefined);
  sub = null;
}
