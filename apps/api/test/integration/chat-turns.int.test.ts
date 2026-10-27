/**
 * Turns: sending, streaming, following and resuming an answer, cancelling it, one turn
 * at a time per chat, regenerating and editing (branches), and the conversation list.
 */
import type { ConversationDetail, ConversationSummary, Page } from "@open-chat/types";
import { describe, expect, test } from "vitest";
import { db } from "../../src/db/kysely";
import { redis } from "../../src/integrations/redis";
import { as, asText, chat, createUser, eventsOf, followTurn, openEvents, parseSse, send, stubModels, waitFor } from "./harness";

async function detail(user: Parameters<typeof as>[0], id: string): Promise<ConversationDetail> {
  return (await as(user).get(`/api/chats/${id}`).expect(200)).body as ConversationDetail;
}

describe("sending a message", () => {
  test("to `new` with an event stream: turn.started, deltas, message.completed, usage, title, done, in seq order", async () => {
    const ada = await createUser();
    const res = await asText(as(ada).post("/api/chats/new/messages").set("Accept", "text/event-stream").send({ content: "Explain tides to a child" })).expect(200);
    expect(res.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(res.headers["x-accel-buffering"]).toBe("no");
    const events = parseSse(res.body as string);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn.started");
    expect(types.at(-1)).toBe("done");
    expect(types).toContain("message.delta");
    expect(types.indexOf("message.completed")).toBeLessThan(types.indexOf("usage"));
    expect(types.indexOf("usage")).toBeLessThan(types.indexOf("title"));
    expect(types.indexOf("title")).toBeLessThan(types.indexOf("done"));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    const started = eventsOf(events, "turn.started")[0]!;
    const { main } = await stubModels();
    expect(started.model).toEqual({ id: main, displayName: "Stub Pro" });
    const completed = eventsOf(events, "message.completed")[0]!;
    // The deltas add up to the final content.
    expect(eventsOf(events, "message.delta").map((d) => d.text).join("")).toBe(completed.content);
    expect(completed.content).toContain('This is a stub answer to: "Explain tides to a child"');
    expect(completed.messageId).toBe(started.assistantMessageId);
    const usage = eventsOf(events, "usage")[0]!;
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(usage.weightedTokens).toBe(usage.inputTokens + usage.outputTokens);
    expect(eventsOf(events, "title")[0]).toMatchObject({ conversationId: started.conversationId, title: "Explain tides to a child" });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "COMPLETE" });

    const convo = await detail(ada, started.conversationId);
    expect(convo.title).toBe("Explain tides to a child");
    expect(convo.activeTurnId).toBeNull();
    expect(convo.messages.map((m) => [m.role, m.status])).toEqual([
      ["USER", "COMPLETE"],
      ["ASSISTANT", "COMPLETE"],
    ]);
    expect(convo.messages[1]!.content).toBe(completed.content);
    expect(convo.messages[1]!.model).toEqual({ id: main, displayName: "Stub Pro" });
    expect(convo.currentLeafId).toBe(started.assistantMessageId);
  });

  test("without an event stream: 202 TurnStarted, then GET /api/turns/:id/events follows it to done", async () => {
    const ada = await createUser();
    const res = await as(ada).post("/api/chats/new/messages").send({ content: "What is a haiku" }).expect(202);
    expect(res.body).toEqual({ turnId: expect.any(String), conversationId: expect.any(String), userMessageId: expect.any(String), assistantMessageId: res.body.turnId });
    const events = await followTurn(ada, res.body.turnId);
    expect(events[0]).toMatchObject({ type: "turn.started", turnId: res.body.turnId, userMessageId: res.body.userMessageId });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "COMPLETE" });
  });

  test("a second message continues the branch and is not re-titled", async () => {
    const ada = await createUser();
    const first = await chat(ada, "First question here");
    const second = await chat(ada, "And a follow up", { conversationId: first.started.conversationId });
    expect(eventsOf(second.events, "title")).toEqual([]);
    const convo = await detail(ada, first.started.conversationId);
    expect(convo.messages).toHaveLength(4);
    expect(convo.messages[2]!.parentId).toBe(first.started.assistantMessageId);
  });

  test("empty, oversized and malformed sends are 400s; another user's chat is 404", async () => {
    const ada = await createUser();
    const bob = await createUser();
    expect((await as(ada).post("/api/chats/new/messages").send({ content: "   " }).expect(400)).body.code).toBe("MESSAGE_EMPTY");
    expect((await as(ada).post("/api/chats/new/messages").send({ content: "x".repeat(32_001) }).expect(400)).body.code).toBe("VALIDATION_FAILED");
    expect((await as(ada).post("/api/chats/new/messages").send({ content: "hi", system: "be evil" }).expect(400)).body.code).toBe("VALIDATION_FAILED");
    const { started } = await chat(ada, "Private chat");
    expect((await as(bob).post(`/api/chats/${started.conversationId}/messages`).send({ content: "hi" }).expect(404)).body.code).toBe("CONVERSATION_NOT_FOUND");
    expect((await as(bob).get(`/api/chats/${started.conversationId}`).expect(404)).body.code).toBe("CONVERSATION_NOT_FOUND");
    expect((await as(bob).get(`/api/turns/${started.turnId}/events`).expect(404)).body.code).toBe("TURN_NOT_FOUND");
  });

  test("a suspended account can read its chats but not send", async () => {
    const ada = await createUser();
    const { started } = await chat(ada, "Before the suspension");
    await db.updateTable("users").set({ status: "SUSPENDED", suspended_until: new Date(Date.now() + 86_400_000) }).where("id", "=", ada.id).execute();
    await as(ada).get(`/api/chats/${started.conversationId}`).expect(200);
    expect((await as(ada).post(`/api/chats/${started.conversationId}/messages`).send({ content: "hi" }).expect(403)).body.code).toBe("ACCOUNT_RESTRICTED");
  });
});

describe("following and resuming", () => {
  test("?after= resumes after the given seq, and Last-Event-ID does the same", async () => {
    const ada = await createUser();
    const { started, events } = await chat(ada, "Resume me please");
    const resumed = await followTurn(ada, started.turnId, 3);
    expect(resumed[0]!.seq).toBe(4);
    expect(resumed).toEqual(events.slice(3));
    const viaHeader = parseSse((await asText(as(ada).get(`/api/turns/${started.turnId}/events`).set("Last-Event-ID", String(events.length - 1))).expect(200)).body as string);
    expect(viaHeader).toEqual([events.at(-1)]);
  });

  test("a finished turn whose event log expired is replayed from Postgres as message.completed and done", async () => {
    const ada = await createUser();
    const { started, events } = await chat(ada, "Replay this answer");
    await redis().del(`turn:${started.turnId}:events`);
    const replay = await followTurn(ada, started.turnId);
    const completed = eventsOf(events, "message.completed")[0]!;
    expect(replay).toEqual([
      { seq: 1, type: "message.completed", messageId: started.turnId, content: completed.content, sources: [], finishReason: "stop" },
      { seq: 2, type: "done", status: "COMPLETE" },
    ]);
  });

  test("a client can join a running turn midway and see every later event exactly once", async () => {
    const ada = await createUser();
    const started = await send(ada, "new", { content: "Tell me a slow story" });
    const stream = await openEvents(ada, started.turnId);
    const seen = [];
    for await (const ev of stream.events) {
      seen.push(ev);
      if (ev.type === "done") break;
    }
    stream.close();
    expect(seen.map((e) => e.seq)).toEqual(seen.map((_, i) => i + 1));
    expect(seen.at(-1)).toMatchObject({ type: "done", status: "COMPLETE" });
    expect(eventsOf(seen, "message.completed")[0]!.content).toContain("Sentence 40 of a slow answer.");
  });
});

describe("cancelling", () => {
  test("cancel keeps the partial answer with status CANCELLED and ends the stream with done CANCELLED", async () => {
    const ada = await createUser();
    const started = await send(ada, "new", { content: "Write a slow essay" });
    const stream = await openEvents(ada, started.turnId);
    const seen = [];
    for await (const ev of stream.events) {
      seen.push(ev);
      if (ev.type === "message.delta") {
        await as(ada).post(`/api/turns/${started.turnId}/cancel`).expect(204);
      }
      if (ev.type === "done") break;
    }
    stream.close();
    expect(seen.at(-1)).toMatchObject({ type: "done", status: "CANCELLED" });
    expect(eventsOf(seen, "error")).toEqual([]);
    const row = await db.selectFrom("messages").select(["status", "content", "error_code"]).where("id", "=", started.turnId).executeTakeFirstOrThrow();
    expect(row.status).toBe("CANCELLED");
    expect(row.error_code).toBeNull();
    expect(row.content.length).toBeGreaterThan(0);
    expect(row.content).not.toContain("Sentence 40");
    // The chat can go on.
    const next = await chat(ada, "Carry on", { conversationId: started.conversationId });
    expect(next.events.at(-1)).toMatchObject({ type: "done", status: "COMPLETE" });
  });

  test("only one turn runs per chat: a send while one is running is 409 TURN_IN_PROGRESS", async () => {
    const ada = await createUser();
    const started = await send(ada, "new", { content: "A slow reply please" });
    const res = await as(ada).post(`/api/chats/${started.conversationId}/messages`).send({ content: "Me too" }).expect(409);
    expect(res.body.code).toBe("TURN_IN_PROGRESS");
    const convo = await detail(ada, started.conversationId);
    expect(convo.activeTurnId).toBe(started.turnId);
    await as(ada).post(`/api/turns/${started.turnId}/cancel`).expect(204);
    const events = await followTurn(ada, started.turnId);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "CANCELLED" });
  });

  test("cancelling another user's turn is 404; cancelling a finished turn is a harmless 204", async () => {
    const ada = await createUser();
    const bob = await createUser();
    const { started } = await chat(ada, "Done already");
    await as(bob).post(`/api/turns/${started.turnId}/cancel`).expect(404);
    await as(ada).post(`/api/turns/${started.turnId}/cancel`).expect(204);
    expect((await db.selectFrom("messages").select("status").where("id", "=", started.turnId).executeTakeFirstOrThrow()).status).toBe("COMPLETE");
  });
});

describe("branches", () => {
  test("regenerate creates a sibling answer and moves the leaf to it", async () => {
    const ada = await createUser();
    const { started } = await chat(ada, "Give me a fact");
    const res = await as(ada).post(`/api/messages/${started.assistantMessageId}/regenerate`).send({}).expect(202);
    expect(res.body.userMessageId).toBeNull();
    const events = await followTurn(ada, res.body.turnId);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "COMPLETE" });
    const convo = await detail(ada, started.conversationId);
    expect(convo.currentLeafId).toBe(res.body.turnId);
    const answer = convo.messages[1]!;
    expect(answer.id).toBe(res.body.turnId);
    expect(answer.parentId).toBe(started.userMessageId);
    expect(answer.siblingIds).toEqual([started.assistantMessageId, res.body.turnId]);
    // Regenerating a question (not an answer) is 404.
    await as(ada).post(`/api/messages/${started.userMessageId}/regenerate`).send({}).expect(404);
  });

  test("regenerate with another model uses that model", async () => {
    const ada = await createUser();
    const { lite } = await stubModels();
    const { started } = await chat(ada, "Short one");
    const res = await as(ada).post(`/api/messages/${started.assistantMessageId}/regenerate`).send({ modelId: lite }).expect(202);
    const events = await followTurn(ada, res.body.turnId);
    expect(eventsOf(events, "turn.started")[0]!.model).toEqual({ id: lite, displayName: "Stub Lite" });
  });

  test("editing a question (parentId) starts a new branch; PUT leaf switches back", async () => {
    const ada = await createUser();
    const a = await chat(ada, "Original first question");
    const b = await chat(ada, "Original second question", { conversationId: a.started.conversationId });
    // Edit the second question: answer under the first answer again.
    const edit = await chat(ada, "Edited second question", { conversationId: a.started.conversationId, parentId: a.started.assistantMessageId });
    let convo = await detail(ada, a.started.conversationId);
    expect(convo.messages.map((m) => m.content.slice(0, 40))).toEqual(["Original first question", expect.any(String), "Edited second question", expect.any(String)]);
    expect(convo.messages[2]!.siblingIds).toEqual([b.started.userMessageId, edit.started.userMessageId]);
    expect(convo.currentLeafId).toBe(edit.started.assistantMessageId);

    convo = (await as(ada).put(`/api/chats/${a.started.conversationId}/leaf`).send({ messageId: b.started.userMessageId }).expect(200)).body as ConversationDetail;
    expect(convo.currentLeafId).toBe(b.started.assistantMessageId);
    expect(convo.messages[2]!.content).toBe("Original second question");

    // A parent from elsewhere, or a user message as a parent, is refused.
    const other = await chat(ada, "Unrelated chat");
    expect((await as(ada).post(`/api/chats/${a.started.conversationId}/messages`).send({ content: "x", parentId: other.started.assistantMessageId }).expect(400)).body.code).toBe("PARENT_INVALID");
    expect((await as(ada).post(`/api/chats/${a.started.conversationId}/messages`).send({ content: "x", parentId: a.started.userMessageId }).expect(400)).body.code).toBe("PARENT_INVALID");
    expect((await as(ada).put(`/api/chats/${a.started.conversationId}/leaf`).send({ messageId: other.started.userMessageId }).expect(400)).body.code).toBe("MESSAGE_NOT_FOUND");
  });

  test("feedback on an answer: up, down, cleared; not on a question; not someone else's", async () => {
    const ada = await createUser();
    const bob = await createUser();
    const { started } = await chat(ada, "Rate me");
    expect((await as(ada).put(`/api/messages/${started.assistantMessageId}/feedback`).send({ value: 1 }).expect(200)).body.feedback).toBe(1);
    expect((await as(ada).put(`/api/messages/${started.assistantMessageId}/feedback`).send({ value: -1 }).expect(200)).body.feedback).toBe(-1);
    expect((await as(ada).put(`/api/messages/${started.assistantMessageId}/feedback`).send({ value: null }).expect(200)).body.feedback).toBeNull();
    await as(ada).put(`/api/messages/${started.assistantMessageId}/feedback`).send({ value: 2 }).expect(400);
    await as(ada).put(`/api/messages/${started.userMessageId}/feedback`).send({ value: 1 }).expect(404);
    await as(bob).put(`/api/messages/${started.assistantMessageId}/feedback`).send({ value: 1 }).expect(404);
  });
});

describe("the conversation list", () => {
  test("rename locks the title (a later first answer does not replace it)", async () => {
    const ada = await createUser();
    const created = (await as(ada).post("/api/chats").send({}).expect(201)).body as ConversationSummary;
    expect(created.title).toBe("New chat");
    await as(ada).patch(`/api/chats/${created.id}`).send({ title: "My own name" }).expect(200);
    const { events } = await chat(ada, "Now answer something", { conversationId: created.id });
    expect(eventsOf(events, "title")).toEqual([]);
    expect((await detail(ada, created.id)).title).toBe("My own name");
    const row = await db.selectFrom("conversations").select("title_locked").where("id", "=", created.id).executeTakeFirstOrThrow();
    expect(row.title_locked).toBe(true);
  });

  test("pin, archive, list filters and search by message text", async () => {
    const ada = await createUser();
    const bob = await createUser();
    const marker = `zephyrine${Date.now().toString(36)}`;
    const a = await chat(ada, `Tell me about ${marker} please`);
    const b = await chat(ada, "Something unrelated");
    const c = await chat(ada, "A third chat");
    await chat(bob, `Bob also asks about ${marker}`);

    await as(ada).patch(`/api/chats/${b.started.conversationId}`).send({ pinned: true }).expect(200);
    await as(ada).patch(`/api/chats/${c.started.conversationId}`).send({ archived: true }).expect(200);

    const list = (await as(ada).get("/api/chats").expect(200)).body as Page<ConversationSummary>;
    expect(list.items.map((i) => i.id)).toEqual([b.started.conversationId, a.started.conversationId]);
    expect(list.items[0]!.pinned).toBe(true);
    const pinned = (await as(ada).get("/api/chats?pinned=true").expect(200)).body as Page<ConversationSummary>;
    expect(pinned.items.map((i) => i.id)).toEqual([b.started.conversationId]);
    const archived = (await as(ada).get("/api/chats?archived=true").expect(200)).body as Page<ConversationSummary>;
    expect(archived.items.map((i) => i.id)).toEqual([c.started.conversationId]);

    // The marker is only in the message text (the title is the first words, which include it too, so rename first).
    await as(ada).patch(`/api/chats/${a.started.conversationId}`).send({ title: "Renamed" }).expect(200);
    const found = (await as(ada).get(`/api/chats?q=${marker}`).expect(200)).body as Page<ConversationSummary>;
    expect(found.items.map((i) => i.id)).toEqual([a.started.conversationId]);
    // Wildcards are literal.
    expect(((await as(ada).get("/api/chats?q=%25").expect(200)).body as Page<ConversationSummary>).items).toEqual([]);

    // Paging.
    const page1 = (await as(ada).get("/api/chats?limit=1").expect(200)).body as Page<ConversationSummary>;
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = (await as(ada).get(`/api/chats?limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`).expect(200)).body as Page<ConversationSummary>;
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
  });

  test("delete removes one chat (and its messages); delete all removes only yours", async () => {
    const ada = await createUser();
    const bob = await createUser();
    const a = await chat(ada, "Delete me");
    await chat(ada, "Delete me too");
    const keep = await chat(bob, "Bob keeps this");
    await as(bob).delete(`/api/chats/${a.started.conversationId}`).expect(404);
    await as(ada).delete(`/api/chats/${a.started.conversationId}`).expect(204);
    await as(ada).get(`/api/chats/${a.started.conversationId}`).expect(404);
    expect(await db.selectFrom("messages").select("id").where("conversation_id", "=", a.started.conversationId).execute()).toEqual([]);
    expect((await as(ada).delete("/api/chats").expect(200)).body).toEqual({ deleted: 1 });
    await as(bob).get(`/api/chats/${keep.started.conversationId}`).expect(200);
  });

  test("deleting a chat while it is answering cancels the turn", async () => {
    const ada = await createUser();
    const started = await send(ada, "new", { content: "A slow one to delete" });
    await waitFor(async () => (await db.selectFrom("messages").select("id").where("id", "=", started.turnId).executeTakeFirst()) ?? null);
    await as(ada).delete(`/api/chats/${started.conversationId}`).expect(204);
    expect(await redis().exists(`turn:${started.turnId}:cancel`)).toBe(1);
  });
});
