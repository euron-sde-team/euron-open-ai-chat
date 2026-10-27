import type { TurnEvent } from "@open-chat/types";
import { describe, expect, it, vi } from "vitest";
import { HttpClient, followTurn, parseSseChunk } from "../src";

const frame = (e: Record<string, unknown>) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

function sseResponse(chunks: string[], opts: { breakAfter?: boolean } = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (opts.breakAfter) controller.error(new TypeError("network lost"));
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("parseSseChunk", () => {
  it("returns complete events and keeps the unfinished tail", () => {
    const text = `${frame({ seq: 1, type: "message.delta", text: "He" })}${frame({ seq: 2, type: "message.delta", text: "llo" })}id: 3\nevent: done\ndata: {"seq":3`;
    const { events, rest } = parseSseChunk(text);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(rest).toContain('"seq":3');
  });
  it("ignores comments, retry lines and malformed data", () => {
    const { events } = parseSseChunk(`retry: 2000\n\n: keep-alive\n\ndata: {not json\n\n${frame({ seq: 1, type: "done", status: "COMPLETE" })}`);
    expect(events).toEqual([{ seq: 1, type: "done", status: "COMPLETE" }]);
  });
  it("handles CRLF line endings and events split across chunks", () => {
    const a = parseSseChunk('data: {"seq":1,"type":"message.de');
    expect(a.events).toEqual([]);
    const b = parseSseChunk(`${a.rest}lta","text":"x"}\r\n\r\n`);
    expect(b.events).toEqual([{ seq: 1, type: "message.delta", text: "x" }]);
  });
});

describe("followTurn", () => {
  it("reconnects when a stream ends without done, with ?after=, and never repeats an event", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      if (urls.length === 1) return sseResponse([frame({ seq: 1, type: "turn.started" }), frame({ seq: 2, type: "message.delta", text: "Hel" })]);
      // The server replays from after=2, but also resends 2 to be safe: the client drops it.
      return sseResponse([frame({ seq: 2, type: "message.delta", text: "Hel" }), frame({ seq: 3, type: "message.delta", text: "lo" }), frame({ seq: 4, type: "done", status: "COMPLETE" })]);
    });
    const http = new HttpClient({ baseUrl: "/api", getAccessToken: () => "t", fetch: fetchMock as unknown as typeof fetch });
    const seen: TurnEvent[] = [];
    for await (const ev of followTurn(http, "T1", { maxRetries: 3 })) seen.push(ev);
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(urls[0]).toBe("/api/turns/T1/events?after=0");
    expect(urls[1]).toBe("/api/turns/T1/events?after=2");
  }, 10_000);

  it("stops on a 404 instead of retrying forever", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Turn not found", code: "TURN_NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } }));
    const http = new HttpClient({ baseUrl: "/api", getAccessToken: () => "t", fetch: fetchMock as unknown as typeof fetch });
    const run = async () => {
      for await (const _ of followTurn(http, "nope")) void _;
    };
    await expect(run()).rejects.toMatchObject({ code: "TURN_NOT_FOUND" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
