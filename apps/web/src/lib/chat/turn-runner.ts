"use client";

/**
 * Runs turns from the browser and writes what they produce straight into the React Query
 * cache, so the conversation on screen is always `qk.chat(id)`:
 *
 *   send       the question and an empty answer appear at once (optimistic), then every
 *              event (deltas, tool steps, sources, images, the title) updates the answer;
 *   done       the conversation is refetched, so what stays on screen is the server's copy;
 *   dropped    if the stream breaks, the runner follows the turn again from the last
 *              sequence number it saw (api-client followTurn): nothing is lost;
 *   reload     a conversation that loads with `activeTurnId` (a turn still running) is
 *              rejoined from the start of its event log by `resume`.
 *
 * Runners live outside React so a turn keeps streaming while the route changes (a new
 * chat moves from / to /c/:id on its first event). Stop asks the server to cancel; the
 * server ends the turn with done CANCELLED and keeps the partial answer.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { ChatFile, ConversationDetail, ConversationSummary, Message, Page, SendMessageInput, TurnEvent } from "@open-chat/types";
import { api } from "../api";
import { qk } from "../query-keys";

type Listener = () => void;

interface Running {
  turnId: string;
  conversationId: string;
  lastSeq: number;
  controller: AbortController;
}

const running = new Map<string, Running>();
const errors = new Map<string, string>();
const listeners = new Set<Listener>();

function notify() {
  for (const l of listeners) l();
}

export const turnState = {
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** The turn streaming in a conversation, if any. */
  activeIn(conversationId: string | null | undefined): string | null {
    if (!conversationId) return null;
    for (const r of running.values()) if (r.conversationId === conversationId) return r.turnId;
    return null;
  },
  isRunning(turnId: string): boolean {
    return running.has(turnId);
  },
  /** The readable reason a turn failed (from its error event). */
  errorOf(messageId: string): string | null {
    return errors.get(messageId) ?? null;
  },
};

function patchMessage(qc: QueryClient, conversationId: string, messageId: string, fn: (m: Message) => Message) {
  qc.setQueryData<ConversationDetail>(qk.chat(conversationId), (d) => (d ? { ...d, messages: d.messages.map((m) => (m.id === messageId ? fn(m) : m)) } : d));
}

function patchSummary(qc: QueryClient, conversationId: string, fn: (c: ConversationSummary) => ConversationSummary) {
  qc.setQueriesData<{ pages: Page<ConversationSummary>[]; pageParams: unknown[] }>({ queryKey: qk.chatsAll }, (data) => {
    if (!data || !("pages" in data)) return data;
    return { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((c) => (c.id === conversationId ? fn(c) : c)) })) };
  });
  qc.setQueryData<ConversationDetail>(qk.chat(conversationId), (d) => (d ? ({ ...d, ...fn(d) } as ConversationDetail) : d));
}

function emptyAnswer(id: string, conversationId: string, parentId: string, model: { id: string; displayName: string } | null, webSearch: boolean, siblingIds: string[]): Message {
  return {
    id,
    conversationId,
    parentId,
    role: "ASSISTANT",
    content: "",
    reasoning: null,
    sources: [],
    toolSteps: [],
    attachments: [],
    outputs: [],
    model,
    status: "STREAMING",
    errorCode: null,
    feedback: null,
    webSearch,
    siblingIds,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
}

/** Apply one event to the cached conversation. Exported for tests. */
export function applyEvent(qc: QueryClient, conversationId: string, answerId: string, ev: TurnEvent): void {
  switch (ev.type) {
    case "message.delta":
      patchMessage(qc, conversationId, answerId, (m) => ({ ...m, content: m.content + ev.text }));
      break;
    case "reasoning.delta":
      patchMessage(qc, conversationId, answerId, (m) => ({ ...m, reasoning: (m.reasoning ?? "") + ev.text }));
      break;
    case "tool.started":
      patchMessage(qc, conversationId, answerId, (m) => ({ ...m, toolSteps: [...m.toolSteps, { tool: ev.tool, label: ev.label, status: "RUNNING" }] }));
      break;
    case "tool.finished":
      patchMessage(qc, conversationId, answerId, (m) => {
        const steps = [...m.toolSteps];
        const i = steps.map((s) => s.status).lastIndexOf("RUNNING");
        if (i >= 0) steps[i] = { tool: ev.tool, label: ev.label, status: ev.ok ? "DONE" : "FAILED" };
        const sources = ev.sources?.length ? [...m.sources, ...ev.sources.filter((s) => !m.sources.some((x) => x.n === s.n))] : m.sources;
        const outputs = ev.image ? [...m.outputs, ev.image] : m.outputs;
        return { ...m, toolSteps: steps, sources, outputs };
      });
      break;
    case "message.completed":
      patchMessage(qc, conversationId, answerId, (m) => ({ ...m, content: ev.content, sources: ev.sources, status: "COMPLETE", completedAt: new Date().toISOString() }));
      break;
    case "title":
      patchSummary(qc, conversationId, (c) => ({ ...c, title: ev.title }));
      break;
    case "error":
      errors.set(answerId, ev.message);
      patchMessage(qc, conversationId, answerId, (m) => ({ ...m, status: "FAILED", errorCode: ev.code }));
      break;
    case "done":
      patchMessage(qc, conversationId, answerId, (m) => ({ ...m, status: ev.status === "COMPLETE" ? "COMPLETE" : ev.status }));
      break;
    default:
      break;
  }
}

async function finish(qc: QueryClient, conversationId: string) {
  // The turn is over here and now: the cached copy must not keep pointing at it, or a view
  // that mounts before the refetch lands would rejoin a finished turn.
  qc.setQueryData<ConversationDetail>(qk.chat(conversationId), (d) => (d ? { ...d, activeTurnId: null } : d));
  await Promise.all([
    qc.invalidateQueries({ queryKey: qk.chat(conversationId) }),
    qc.invalidateQueries({ queryKey: qk.chatsAll }),
    qc.invalidateQueries({ queryKey: qk.usage }),
  ]);
}

/** Consume events until done; on a broken stream, follow the turn from the last seq. */
async function drive(qc: QueryClient, r: Running, answerId: string, first: AsyncIterable<TurnEvent> | null): Promise<void> {
  let ended = false;
  const handle = (ev: TurnEvent) => {
    if (ev.seq <= r.lastSeq) return;
    r.lastSeq = ev.seq;
    applyEvent(qc, r.conversationId, answerId, ev);
    if (ev.type === "done") ended = true;
  };
  try {
    if (first) {
      try {
        for await (const ev of first) handle(ev);
      } catch (err) {
        if (r.controller.signal.aborted) return;
        // Fall through to follow from where the stream broke.
        void err;
      }
    }
    if (!ended && !r.controller.signal.aborted) {
      for await (const ev of api().turns.follow(r.turnId, { after: r.lastSeq, signal: r.controller.signal })) handle(ev);
    }
  } catch (err) {
    if (!r.controller.signal.aborted) {
      errors.set(answerId, "The connection was lost. Reload the chat to see the answer.");
      patchMessage(qc, r.conversationId, answerId, (m) => (m.status === "STREAMING" ? { ...m, status: "FAILED", errorCode: "INTERNAL" } : m));
    }
    void err;
  } finally {
    running.delete(r.turnId);
    notify();
    await finish(qc, r.conversationId);
  }
}

export interface SendArgs extends SendMessageInput {
  conversationId: string | null;
  projectId?: string | null;
  /** The attachments as the composer holds them, for the optimistic question. */
  files?: ChatFile[];
  /** Called with the conversation id as soon as the server accepted the message. */
  onStarted?: (conversationId: string) => void;
}

/** Send a message and stream its answer into the cache. Resolves when the turn ends. */
export async function sendMessage(qc: QueryClient, args: SendArgs): Promise<void> {
  const { conversationId, files = [], onStarted, ...body } = args;
  const controller = new AbortController();
  const stream = api().chats.sendStreaming(conversationId ?? "new", body, controller.signal);
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || first.value.type !== "turn.started") throw new Error("The server did not start the answer");
  const started = first.value;
  const convId = started.conversationId;
  const r: Running = { turnId: started.turnId, conversationId: convId, lastSeq: started.seq, controller };
  running.set(r.turnId, r);
  errors.delete(started.assistantMessageId);

  // Optimistic: the question and an empty answer, on the branch being continued.
  const existing = qc.getQueryData<ConversationDetail>(qk.chat(convId));
  const parentId = body.parentId === undefined ? (existing?.currentLeafId ?? null) : body.parentId;
  const keep: Message[] = [];
  if (existing && parentId) {
    for (const m of existing.messages) {
      keep.push(m);
      if (m.id === parentId) break;
    }
  }
  const replaced = existing?.messages.find((m) => m.role === "USER" && m.parentId === parentId);
  const question: Message = {
    ...emptyAnswer(started.userMessageId!, convId, parentId ?? "", null, false, replaced ? [...replaced.siblingIds, started.userMessageId!] : [started.userMessageId!]),
    parentId,
    role: "USER",
    content: body.content,
    attachments: files,
    status: "COMPLETE",
  };
  const answer = emptyAnswer(started.assistantMessageId, convId, question.id, started.model, body.webSearch ?? false, [started.assistantMessageId]);
  const now = new Date().toISOString();
  qc.setQueryData<ConversationDetail>(qk.chat(convId), {
    id: convId,
    title: existing?.title ?? (body.content.slice(0, 60) || "New chat"),
    projectId: existing?.projectId ?? args.projectId ?? null,
    pinned: existing?.pinned ?? false,
    archived: false,
    lastMessageAt: now,
    createdAt: existing?.createdAt ?? now,
    currentLeafId: answer.id,
    messages: [...keep, question, answer],
    activeTurnId: r.turnId,
  });
  if (!existing) void qc.invalidateQueries({ queryKey: qk.chatsAll });
  notify();
  onStarted?.(convId);

  const rest = { [Symbol.asyncIterator]: () => iterator };
  await drive(qc, r, answer.id, rest);
}

/** Regenerate an answer: a new sibling under the same question, streamed into the cache. */
export async function regenerate(qc: QueryClient, conversationId: string, answer: Message, opts: { modelId?: string } = {}): Promise<void> {
  const started = await api().messages.regenerate(answer.id, opts);
  const controller = new AbortController();
  const r: Running = { turnId: started.turnId, conversationId, lastSeq: 0, controller };
  running.set(r.turnId, r);
  qc.setQueryData<ConversationDetail>(qk.chat(conversationId), (d) => {
    if (!d) return d;
    const idx = d.messages.findIndex((m) => m.id === answer.id);
    const before = idx >= 0 ? d.messages.slice(0, idx) : d.messages;
    const fresh = emptyAnswer(started.assistantMessageId, conversationId, answer.parentId ?? "", answer.model, answer.webSearch, [...answer.siblingIds, started.assistantMessageId]);
    return { ...d, messages: [...before, fresh], currentLeafId: fresh.id, activeTurnId: r.turnId };
  });
  notify();
  await drive(qc, r, started.assistantMessageId, null);
}

/** Rejoin a turn that was running when the conversation loaded (a reload mid-answer). */
export function resume(qc: QueryClient, detail: ConversationDetail): void {
  const turnId = detail.activeTurnId;
  if (!turnId || running.has(turnId)) return;
  // Only an answer still being written is worth rejoining.
  if (detail.messages.find((m) => m.id === turnId)?.status !== "STREAMING") return;
  const r: Running = { turnId, conversationId: detail.id, lastSeq: 0, controller: new AbortController() };
  running.set(turnId, r);
  // The stored answer is empty until the turn ends; replaying from 0 rebuilds it.
  patchMessage(qc, detail.id, turnId, (m) => ({ ...m, content: "", reasoning: null, toolSteps: [], sources: [], outputs: [] }));
  notify();
  void drive(qc, r, turnId, null);
}

/** Ask the server to stop a turn (the partial answer is kept). */
export async function stop(turnId: string): Promise<void> {
  await api().turns.cancel(turnId);
}

/** Stop following everything (sign-out). Turns go on on the server. */
export function detachAll(): void {
  for (const r of running.values()) r.controller.abort();
  running.clear();
  notify();
}
