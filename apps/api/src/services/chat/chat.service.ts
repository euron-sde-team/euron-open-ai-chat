/**
 * Conversations and turns, as the API sees them. Every lookup is scoped to the actor in
 * the query, so another account's conversation or message id is a plain 404.
 *
 * Sending a message stores the question and an empty STREAMING answer in one transaction,
 * moves the conversation's leaf to the answer, then starts the turn (turns.ts) without
 * waiting for it. Editing a question is sending under an earlier parent (a new branch);
 * regenerating is a new answer under the same question (a sibling). Old branches are
 * kept and reachable through PUT /api/chats/:id/leaf.
 */
import type { AspectRatio, ConversationDetail, ConversationSummary, Message, Page, SendMessageInput, TurnEvent, TurnStarted } from "@open-chat/types";
import { sql } from "kysely";
import { config, searchConfigured } from "../../core/config";
import { type Actor, requireActive } from "../../core/context";
import { badRequest, conflict, HttpError, notFound } from "../../core/errors";
import { newId } from "../../core/ids";
import { db } from "../../db/kysely";
import { atKey, decodeTime, olderThan, timePage } from "../../repositories/keyset";
import { consume } from "../../middleware/rate-limit";
import { toMessages, toSummary } from "../../presenters/chat.presenter";
import { chatRepo, type ConversationRow, type MessageRow } from "../../repositories/chat.repository";
import { attachableFiles } from "../file.service";
import { resolveChatModel, resolveKind } from "../models.service";
import { preferencesOf } from "../preferences.service";
import { getSettings } from "../settings.service";
import { follow, hasLog, requestCancel } from "./event-log";
import { fallbackTitle } from "./titles";
import { startTurn, type TurnPlan } from "./turns";

export const MAX_MESSAGE_CHARS = 32_000;
export const MAX_FILES_PER_MESSAGE = 10;

async function ownConversation(actor: Actor, id: string): Promise<ConversationRow> {
  const c = await chatRepo.findConversation(actor.id, id);
  if (!c) throw notFound("Conversation not found", "CONVERSATION_NOT_FOUND");
  return c;
}

// ─── Conversations ──────────────────────────────────────────────────────────

export interface ListQuery {
  cursor?: string;
  limit?: number;
  q?: string;
  projectId?: string;
  archived?: boolean;
  pinned?: boolean;
}

export async function listConversations(actor: Actor, query: ListQuery): Promise<Page<ConversationSummary>> {
  const limit = Math.min(query.limit ?? 30, 100);
  let q = db.selectFrom("conversations as c").selectAll("c").select(atKey("c.last_message_at")).where("c.user_id", "=", actor.id);
  q = query.archived ? q.where("c.archived_at", "is not", null) : q.where("c.archived_at", "is", null);
  if (query.projectId) q = q.where("c.project_id", "=", query.projectId);
  if (query.pinned !== undefined) q = query.pinned ? q.where("c.pinned_at", "is not", null) : q.where("c.pinned_at", "is", null);
  if (query.q?.trim()) {
    const term = query.q.trim().slice(0, 200);
    q = q.where((eb) =>
      eb.or([
        eb("c.title", "ilike", `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`),
        eb.exists(eb.selectFrom("messages as m").select("m.id").whereRef("m.conversation_id", "=", "c.id").where(sql<boolean>`m.search @@ websearch_to_tsquery('simple', ${term})`)),
      ]),
    );
  }
  const rows = await q.where(olderThan("c.last_message_at", "c.id", decodeTime(query.cursor))).orderBy("c.last_message_at", "desc").orderBy("c.id", "desc").limit(limit + 1).execute();
  const page = timePage(rows, limit);
  return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
}

export async function createConversation(actor: Actor, input: { title?: string; projectId?: string | null }): Promise<ConversationSummary> {
  requireActive(actor);
  if (input.projectId) await ownProject(actor, input.projectId);
  const row = await chatRepo.insertConversation({ id: newId(), user_id: actor.id, project_id: input.projectId ?? null, title: input.title?.trim() || "New chat", title_locked: !!input.title?.trim() });
  return toSummary(row);
}

async function ownProject(actor: Actor, id: string): Promise<void> {
  const p = await db.selectFrom("projects").select("id").where("id", "=", id).where("user_id", "=", actor.id).executeTakeFirst();
  if (!p) throw notFound("Project not found", "PROJECT_NOT_FOUND");
}

export async function getConversation(actor: Actor, id: string): Promise<ConversationDetail> {
  const c = await ownConversation(actor, id);
  const path = await chatRepo.pathTo(c.id, c.current_leaf_id);
  const streaming = await chatRepo.findStreaming(c.id);
  return { ...toSummary(c), currentLeafId: c.current_leaf_id, messages: await toMessages(c.id, path), activeTurnId: streaming?.id ?? null };
}

export async function updateConversation(actor: Actor, id: string, patch: { title?: string; pinned?: boolean; archived?: boolean; projectId?: string | null }): Promise<ConversationSummary> {
  requireActive(actor);
  await ownConversation(actor, id);
  if (patch.projectId) await ownProject(actor, patch.projectId);
  const now = new Date();
  const row = await chatRepo.updateConversation(id, {
    ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 120) || "New chat", title_locked: true } : {}),
    ...(patch.pinned !== undefined ? { pinned_at: patch.pinned ? now : null } : {}),
    ...(patch.archived !== undefined ? { archived_at: patch.archived ? now : null } : {}),
    ...(patch.projectId !== undefined ? { project_id: patch.projectId } : {}),
  });
  return toSummary(row!);
}

export async function deleteConversation(actor: Actor, id: string): Promise<void> {
  await ownConversation(actor, id);
  const streaming = await chatRepo.findStreaming(id);
  if (streaming) await requestCancel(streaming.id);
  // Messages and their file links go with it; files nobody references are removed by maintenance.expire-files.
  await db.deleteFrom("conversations").where("id", "=", id).where("user_id", "=", actor.id).execute();
}

export async function deleteAllConversations(actor: Actor): Promise<number> {
  const res = await db.deleteFrom("conversations").where("user_id", "=", actor.id).executeTakeFirst();
  return Number(res.numDeletedRows);
}

// ─── Turns ──────────────────────────────────────────────────────────────────

interface Prepared {
  plan: Omit<TurnPlan, "conversation" | "question" | "answerId" | "firstAnswer">;
}

async function prepare(actor: Actor, input: { modelId?: string; webSearch?: boolean; mode?: "chat" | "image"; aspectRatio?: AspectRatio; hasImages: boolean }): Promise<Prepared> {
  const [settings, prefs] = await Promise.all([getSettings(), preferencesOf(actor.id)]);
  const mode = input.mode ?? "chat";
  const model = await resolveChatModel(input.modelId, prefs.defaultModelId);
  if (!model) throw new HttpError(503, "No chat model is available. An admin needs to configure a provider.", "MODEL_UNAVAILABLE");
  const imageModel = settings.features.imageGeneration ? await resolveKind("IMAGE") : null;
  if (mode === "image" && !imageModel) throw badRequest("Image generation is not available", "IMAGES_UNAVAILABLE");
  if (mode === "chat" && input.hasImages && !model.model.supports_vision) throw badRequest(`${model.model.display_name} cannot see images. Pick a model with vision.`, "MODEL_NO_VISION");
  return {
    plan: {
      userId: actor.id,
      model,
      imageModel,
      mode,
      aspectRatio: input.aspectRatio ?? "1:1",
      webSearch: input.webSearch ?? prefs.webSearchDefault,
      prefs,
      features: settings.features,
      searchAvailable: searchConfigured(config),
      appName: settings.appName,
      addendum: settings.systemPromptAddendum,
    },
  };
}

async function assertIdle(conversationId: string): Promise<void> {
  if (await chatRepo.findStreaming(conversationId)) throw conflict("An answer is still being written in this chat", "TURN_IN_PROGRESS");
}

/**
 * Send a message. `conversationId` "new" starts a conversation (in `projectId`, when
 * given). `parentId` omitted continues the branch on screen; a parent id (or null for
 * the very first question) edits an earlier question as a new branch.
 */
export async function sendMessage(actor: Actor, conversationId: string, input: SendMessageInput & { projectId?: string | null }): Promise<TurnStarted> {
  requireActive(actor);
  await consume("turns", `u:${actor.id}`, 30, 60);
  const content = input.content.trim();
  const fileIds = input.fileIds ?? [];
  if (!content && !fileIds.length) throw badRequest("Write a message or attach a file", "MESSAGE_EMPTY");
  if (content.length > MAX_MESSAGE_CHARS) throw badRequest(`Messages can be at most ${MAX_MESSAGE_CHARS} characters`, "MESSAGE_TOO_LONG");
  if (fileIds.length > MAX_FILES_PER_MESSAGE) throw badRequest(`Attach at most ${MAX_FILES_PER_MESSAGE} files`, "TOO_MANY_FILES");
  if (input.mode === "image" && !content) throw badRequest("Describe the image you want", "MESSAGE_EMPTY");

  const files = await attachableFiles(actor, fileIds);
  const { plan } = await prepare(actor, { ...input, hasImages: files.some((f) => f.kind === "IMAGE") });

  let conversation: ConversationRow;
  if (conversationId === "new") {
    if (input.projectId) await ownProject(actor, input.projectId);
    conversation = await chatRepo.insertConversation({ id: newId(), user_id: actor.id, project_id: input.projectId ?? null, title: fallbackTitle(content || files[0]!.file_name) });
  } else {
    conversation = await ownConversation(actor, conversationId);
    await assertIdle(conversation.id);
  }

  let parentId: string | null;
  if (input.parentId === undefined) parentId = conversation.current_leaf_id;
  else if (input.parentId === null) parentId = null;
  else {
    const parent = await chatRepo.findMessage(input.parentId);
    if (!parent || parent.conversation_id !== conversation.id) throw badRequest("That message is not in this conversation", "PARENT_INVALID");
    if (parent.role !== "ASSISTANT") throw badRequest("A question goes under an answer", "PARENT_INVALID");
    parentId = parent.id;
  }
  const firstAnswer = !(await db.selectFrom("messages").select("id").where("conversation_id", "=", conversation.id).where("role", "=", "ASSISTANT").where("status", "=", "COMPLETE").executeTakeFirst());

  const questionId = newId();
  const answerId = newId();
  const { question } = await db.transaction().execute(async (trx) => {
    const question = await chatRepo.insertMessage({ id: questionId, conversation_id: conversation.id, parent_id: parentId, role: "USER", content }, trx);
    if (files.length) await trx.insertInto("message_files").values(files.map((f, i) => ({ message_id: questionId, file_id: f.id, direction: "INPUT", position: i }))).execute();
    await chatRepo.insertMessage({ id: answerId, conversation_id: conversation.id, parent_id: questionId, role: "ASSISTANT", status: "STREAMING", model_id: plan.model.model.id, web_search: plan.webSearch }, trx);
    await trx.updateTable("conversations").set({ current_leaf_id: answerId, last_message_at: new Date(), updated_at: new Date() }).where("id", "=", conversation.id).execute();
    return { question };
  });
  startTurn({ ...plan, conversation: { ...conversation, current_leaf_id: answerId }, question, answerId, firstAnswer });
  return { turnId: answerId, conversationId: conversation.id, userMessageId: questionId, assistantMessageId: answerId };
}

/** A new answer to the same question, as a sibling of `messageId` (an answer). */
export async function regenerate(actor: Actor, messageId: string, input: { modelId?: string; webSearch?: boolean }): Promise<TurnStarted> {
  requireActive(actor);
  await consume("turns", `u:${actor.id}`, 30, 60);
  const answer = await chatRepo.findOwnedMessage(actor.id, messageId);
  if (!answer || answer.role !== "ASSISTANT" || !answer.parent_id) throw notFound("Message not found", "MESSAGE_NOT_FOUND");
  const conversation = await ownConversation(actor, answer.conversation_id);
  await assertIdle(conversation.id);
  const question = (await chatRepo.findMessage(answer.parent_id)) as MessageRow;
  const links = await chatRepo.fileIdsOf([question.id]);
  const hasImages = links.length ? (await db.selectFrom("files").select("kind").where("id", "in", links.map((l) => l.file_id)).execute()).some((f) => f.kind === "IMAGE") : false;
  const imageTurn = (answer.tool_trace as unknown as { tool: string }[]).some((s) => s.tool === "generate_image") && !answer.content.trim();
  const { plan } = await prepare(actor, { modelId: input.modelId ?? answer.model_id ?? undefined, webSearch: input.webSearch ?? answer.web_search, mode: imageTurn ? "image" : "chat", hasImages: hasImages && !imageTurn });
  const answerId = newId();
  await db.transaction().execute(async (trx) => {
    await chatRepo.insertMessage({ id: answerId, conversation_id: conversation.id, parent_id: question.id, role: "ASSISTANT", status: "STREAMING", model_id: plan.model.model.id, web_search: plan.webSearch }, trx);
    await trx.updateTable("conversations").set({ current_leaf_id: answerId, last_message_at: new Date(), updated_at: new Date() }).where("id", "=", conversation.id).execute();
  });
  startTurn({ ...plan, conversation: { ...conversation, current_leaf_id: answerId }, question, answerId, firstAnswer: false });
  return { turnId: answerId, conversationId: conversation.id, userMessageId: null, assistantMessageId: answerId };
}

/** Show the branch through `messageId`: the leaf becomes its newest descendant. */
export async function setLeaf(actor: Actor, conversationId: string, messageId: string): Promise<ConversationDetail> {
  const c = await ownConversation(actor, conversationId);
  const m = await chatRepo.findMessage(messageId);
  if (!m || m.conversation_id !== c.id) throw badRequest("That message is not in this conversation", "MESSAGE_NOT_FOUND");
  const leaf = await chatRepo.newestLeafUnder(m.id);
  await chatRepo.updateConversation(c.id, { current_leaf_id: leaf });
  return getConversation(actor, c.id);
}

export async function setFeedback(actor: Actor, messageId: string, value: -1 | 1 | null): Promise<Message> {
  const m = await chatRepo.findOwnedMessage(actor.id, messageId);
  if (!m || m.role !== "ASSISTANT") throw notFound("Message not found", "MESSAGE_NOT_FOUND");
  const row = await chatRepo.updateMessage(m.id, { feedback: value });
  return (await toMessages(m.conversation_id, [row!]))[0]!;
}

/** The actor's turn, or 404. */
export async function checkTurn(actor: Actor, turnId: string): Promise<void> {
  await ownTurn(actor, turnId);
}

async function ownTurn(actor: Actor, turnId: string): Promise<MessageRow> {
  const m = await chatRepo.findOwnedMessage(actor.id, turnId);
  if (!m || m.role !== "ASSISTANT") throw notFound("Turn not found", "TURN_NOT_FOUND");
  return m;
}

/**
 * The events of a turn after `after`. Live turns are followed through the event log;
 * once the log has expired the finished message is replayed from Postgres as a final
 * `message.completed` and `done`, so a late client still gets the answer.
 */
export async function* turnEvents(actor: Actor, turnId: string, after: number, stop: AbortSignal): AsyncGenerator<TurnEvent> {
  const m = await ownTurn(actor, turnId);
  if (await hasLog(turnId)) {
    yield* follow(turnId, after, stop);
    return;
  }
  if (m.status === "STREAMING") {
    // Accepted moments ago and the first event is not written yet: follow anyway.
    yield* follow(turnId, after, stop, 15_000);
    return;
  }
  const fresh = (await chatRepo.findMessage(turnId))!;
  let seq = after;
  if (fresh.status === "COMPLETE") yield { seq: ++seq, type: "message.completed", messageId: fresh.id, content: fresh.content, sources: (fresh.sources as unknown as TurnEventSources) ?? [], finishReason: fresh.finish_reason ?? "stop" };
  yield { seq: ++seq, type: "done", status: fresh.status === "STREAMING" ? "FAILED" : fresh.status };
}
type TurnEventSources = Extract<TurnEvent, { type: "message.completed" }>["sources"];

export async function cancelTurn(actor: Actor, turnId: string): Promise<void> {
  const m = await ownTurn(actor, turnId);
  if (m.status === "STREAMING") await requestCancel(turnId);
}
