import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ConversationDetail, Message } from "@open-chat/types";
import { groupByDate } from "@/lib/chat/queries";
import { applyEvent, turnState } from "@/lib/chat/turn-runner";
import { qk } from "@/lib/query-keys";

const answer = (over: Partial<Message> = {}): Message => ({
  id: "A1",
  conversationId: "C1",
  parentId: "Q1",
  role: "ASSISTANT",
  content: "",
  reasoning: null,
  sources: [],
  toolSteps: [],
  attachments: [],
  outputs: [],
  model: null,
  status: "STREAMING",
  errorCode: null,
  feedback: null,
  webSearch: true,
  siblingIds: ["A1"],
  createdAt: "",
  completedAt: null,
  ...over,
});

function setup() {
  const qc = new QueryClient();
  const detail: ConversationDetail = { id: "C1", title: "New chat", projectId: null, pinned: false, archived: false, lastMessageAt: "", createdAt: "", currentLeafId: "A1", messages: [answer()], activeTurnId: "A1" };
  qc.setQueryData(qk.chat("C1"), detail);
  const get = () => qc.getQueryData<ConversationDetail>(qk.chat("C1"))!.messages[0]!;
  return { qc, get };
}

describe("applyEvent", () => {
  it("appends deltas in order and replaces with the completed text", () => {
    const { qc, get } = setup();
    applyEvent(qc, "C1", "A1", { seq: 2, type: "message.delta", text: "Hel" });
    applyEvent(qc, "C1", "A1", { seq: 3, type: "message.delta", text: "lo" });
    expect(get().content).toBe("Hello");
    applyEvent(qc, "C1", "A1", { seq: 4, type: "message.completed", messageId: "A1", content: "Hello there", sources: [], finishReason: "stop" });
    expect(get()).toMatchObject({ content: "Hello there", status: "COMPLETE" });
  });

  it("tracks tool steps, adds numbered sources once, and shows generated images", () => {
    const { qc, get } = setup();
    applyEvent(qc, "C1", "A1", { seq: 2, type: "tool.started", callId: "c", tool: "web_search", label: "Searching" });
    expect(get().toolSteps).toEqual([{ tool: "web_search", label: "Searching", status: "RUNNING" }]);
    const src = { n: 1, title: "T", url: "https://example.org", domain: "example.org", snippet: "", publishedAt: null };
    applyEvent(qc, "C1", "A1", { seq: 3, type: "tool.finished", callId: "c", tool: "web_search", label: "Found 1", ok: true, sources: [src] });
    applyEvent(qc, "C1", "A1", { seq: 4, type: "tool.finished", callId: "c", tool: "web_search", label: "Found 1", ok: true, sources: [src] });
    expect(get().toolSteps[0]).toEqual({ tool: "web_search", label: "Found 1", status: "DONE" });
    expect(get().sources).toHaveLength(1);
  });

  it("marks a failed turn and keeps the readable reason", () => {
    const { qc, get } = setup();
    applyEvent(qc, "C1", "A1", { seq: 2, type: "error", code: "QUOTA_EXCEEDED", message: "You have used today's allowance." });
    applyEvent(qc, "C1", "A1", { seq: 3, type: "done", status: "FAILED" });
    expect(get()).toMatchObject({ status: "FAILED", errorCode: "QUOTA_EXCEEDED" });
    expect(turnState.errorOf("A1")).toBe("You have used today's allowance.");
  });

  it("updates the title everywhere it is cached", () => {
    const { qc } = setup();
    applyEvent(qc, "C1", "A1", { seq: 5, type: "title", conversationId: "C1", title: "Caching basics" });
    expect(qc.getQueryData<ConversationDetail>(qk.chat("C1"))!.title).toBe("Caching basics");
  });
});

describe("groupByDate", () => {
  it("groups by Today, Yesterday, the last week and month, then months", () => {
    const now = new Date(2026, 9, 27, 15, 0);
    const at = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    const c = (id: string, days: number) => ({ id, title: id, projectId: null, pinned: false, archived: false, lastMessageAt: at(days), createdAt: at(days) });
    const groups = groupByDate([c("a", 0), c("b", 1), c("c", 3), c("d", 20), c("e", 120)], now);
    expect(groups.map((g) => g.label).slice(0, 4)).toEqual(["Today", "Yesterday", "Previous 7 days", "Previous 30 days"]);
    expect(groups).toHaveLength(5);
  });
});
