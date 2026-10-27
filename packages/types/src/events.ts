/**
 * The turn event stream (docs/api/streaming.md). A turn is one assistant answer being
 * generated on the server. Its events are kept for a while after it ends, each with a
 * sequence number, so a client that loses its connection (a phone going to the
 * background, a train tunnel) resumes with GET /api/turns/:id/events?after=<seq>
 * and misses nothing.
 *
 * On the wire every event is one Server-Sent Event:
 *
 *   id: 7
 *   event: message.delta
 *   data: {"seq":7,"type":"message.delta","text":"Hel"}
 */
import type { ChatFile, Source, ToolName } from "./chat";

interface Base {
  /** Monotonic per turn, starting at 1. Resume with ?after=<last seq you saw>. */
  seq: number;
}

export type TurnEvent =
  | (Base & { type: "turn.started"; turnId: string; conversationId: string; userMessageId: string | null; assistantMessageId: string; model: { id: string; displayName: string } })
  /** A piece of the answer. Append in order. */
  | (Base & { type: "message.delta"; text: string })
  /** A piece of the model's visible reasoning summary, when it streams one. */
  | (Base & { type: "reasoning.delta"; text: string })
  | (Base & { type: "tool.started"; callId: string; tool: ToolName; label: string })
  | (Base & {
      type: "tool.finished";
      callId: string;
      tool: ToolName;
      label: string;
      ok: boolean;
      /** web_search: the sources found (numbered for citations). */
      sources?: Source[];
      /** generate_image: the image, ready to show. */
      image?: ChatFile;
    })
  /** The finished message. Its content is the full answer; replace what you assembled. */
  | (Base & { type: "message.completed"; messageId: string; content: string; sources: Source[]; finishReason: string })
  | (Base & { type: "usage"; inputTokens: number; outputTokens: number; weightedTokens: number })
  /** A new auto title for the conversation (after its first answer). */
  | (Base & { type: "title"; conversationId: string; title: string })
  /** Something went wrong. `code` is stable; `message` is safe to show (never raw provider text). */
  | (Base & { type: "error"; code: TurnErrorCode; message: string })
  /** Always the last event. */
  | (Base & { type: "done"; status: "COMPLETE" | "CANCELLED" | "FAILED" });

export type TurnEventType = TurnEvent["type"];

export type TurnErrorCode =
  | "QUOTA_EXCEEDED"
  | "MODEL_UNAVAILABLE"
  | "PROVIDER_ERROR"
  | "PROVIDER_RATE_LIMITED"
  | "CONTEXT_TOO_LONG"
  | "CONTENT_BLOCKED"
  | "INTERNAL";

/** Distributive Omit, so building an event keeps the union narrow. */
export type TurnEventInput = TurnEvent extends infer E ? (E extends TurnEvent ? Omit<E, "seq"> : never) : never;
