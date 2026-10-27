/**
 * Server-Sent Events responses. Headers go out at once (no buffering in proxies: the ALB
 * passes chunks through, nginx needs X-Accel-Buffering), a comment line every 15 seconds
 * keeps idle connections alive, and a closed connection aborts `signal` so the caller
 * stops following the turn. The turn itself is not stopped by a disconnect.
 */
import type { Request, Response } from "express";
import type { TurnEvent } from "@open-chat/types";

export interface SseStream {
  signal: AbortSignal;
  send(event: TurnEvent): void;
  end(): void;
}

export function openSse(req: Request, res: Response): SseStream {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const controller = new AbortController();
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  const close = () => {
    clearInterval(keepAlive);
    controller.abort();
  };
  req.on("close", close);
  res.write("retry: 2000\n\n");
  return {
    signal: controller.signal,
    send(event) {
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      close();
      res.end();
    },
  };
}

/** The resume point: ?after= wins, then the browser's automatic Last-Event-ID header. */
export function resumeAfter(req: Request): number {
  const raw = (req.query.after as string | undefined) ?? req.get("last-event-id") ?? "0";
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < 1_000_000 ? n : 0;
}
