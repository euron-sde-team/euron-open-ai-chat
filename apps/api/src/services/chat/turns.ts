/**
 * One turn: an assistant answer generated on the server (ADR 0005).
 *
 * The turn runs in the API task that accepted the request, but it is not tied to that
 * request: closing the tab or losing the network does not stop it. Its events go to the
 * turn event log (event-log.ts), which any client can follow and rejoin. A cancel from
 * any task reaches it through Redis. If the task dies, maintenance.sweep-turns fails the
 * message so the conversation can go on.
 *
 * Steps: quota check, optional moderation, context, then up to MAX_ROUNDS model calls
 * with tools, then persistence, usage, and (on a conversation's first answer) a title.
 */
import type { AspectRatio, Preferences, Source, ToolName, ToolStep, TurnErrorCode } from "@open-chat/types";
import { captureError, logger } from "../../core/logger";
import { db } from "../../db/kysely";
import { estimateTokens } from "../../domain/chunking";
import { ProviderError } from "../../integrations/http";
import type { LlmEvent, LlmMessage, LlmTool, LlmToolCall } from "../../integrations/llm";
import { moderate } from "../../integrations/moderation";
import { toFile } from "../../presenters/file.presenter";
import { chatRepo, type ConversationRow, type MessageRow } from "../../repositories/chat.repository";
import { fileRepo, type FileRow } from "../../repositories/file.repository";
import { enqueue } from "../../jobs/registry";
import { readImageBase64 } from "../file.service";
import type { ResolvedModel } from "../models.service";
import { assertTokensLeft, QuotaExceededError, recordUsage, weighted } from "../quota.service";
import { buildContext, visionMessageIds, type ContextFile } from "./context";
import { onCancel, TurnWriter } from "./event-log";
import { systemPrompt } from "./prompt";
import { generateTitle } from "./titles";
import { makeImage, MAX_CALLS, MAX_ROUNDS, parseArgs, searchableFiles, TOOLS, type ToolContext } from "./tools";

export interface TurnPlan {
  userId: string;
  conversation: ConversationRow;
  /** The user message being answered (already stored). */
  question: MessageRow;
  /** The assistant message row (already stored, STREAMING); its id is the turn id. */
  answerId: string;
  model: ResolvedModel;
  imageModel: ResolvedModel | null;
  mode: "chat" | "image";
  aspectRatio: AspectRatio;
  webSearch: boolean;
  prefs: Preferences;
  features: { webSearch: boolean; imageGeneration: boolean; memory: boolean; projects: boolean };
  searchAvailable: boolean;
  appName: string;
  addendum: string;
  /** The conversation had no answer before this one: write a title when done. */
  firstAnswer: boolean;
}

const DELTA_FLUSH_MS = 40;
const DELTA_FLUSH_CHARS = 96;
const TITLE_WAIT_MS = 6_000;

/** Start a turn without awaiting it. Errors are handled inside; nothing escapes to the request. */
export function startTurn(plan: TurnPlan): void {
  void runTurn(plan).catch((err) => captureError(err, { where: "runTurn", turnId: plan.answerId }));
}

export async function runTurn(plan: TurnPlan): Promise<void> {
  const writer = new TurnWriter(plan.answerId);
  const controller = new AbortController();
  const offCancel = await onCancel(plan.answerId, controller);
  const state = { content: "", reasoning: "", sources: [] as Source[], steps: [] as ToolStep[], outputs: [] as FileRow[], input: 0, output: 0, toolCalls: 0, finish: "stop", estimated: 0, dropped: 0 };

  // Text deltas are coalesced: one event per ~40ms or ~100 characters, not one per token.
  let pending = "";
  let timer: NodeJS.Timeout | null = null;
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const text = pending;
    pending = "";
    await writer.emit({ type: "message.delta", text });
  };
  const pushText = async (text: string) => {
    state.content += text;
    pending += text;
    if (pending.length >= DELTA_FLUSH_CHARS) await flush();
    else if (!timer) timer = setTimeout(() => void flush().catch(() => undefined), DELTA_FLUSH_MS);
  };

  try {
    await writer.emit({ type: "turn.started", turnId: plan.answerId, conversationId: plan.conversation.id, userMessageId: plan.question.id, assistantMessageId: plan.answerId, model: { id: plan.model.model.id, displayName: plan.model.model.display_name } });

    if ((await moderate(plan.question.content)).flagged) throw new TurnFailure("CONTENT_BLOCKED");

    if (plan.mode === "image") {
      await runImageTurn(plan, writer, state, controller.signal);
    } else {
      await assertTokensLeft(plan.userId);
      await runChatTurn(plan, writer, state, controller.signal, pushText, flush);
    }
    await flush();
    if (!state.input && !state.output && plan.mode === "chat") {
      // The provider reported no usage: estimate it so the allowance still moves.
      state.input = state.estimated;
      state.output = estimateTokens(state.content + state.reasoning);
    }

    const finished = new Date();
    await db.transaction().execute(async (trx) => {
      await chatRepo.updateMessage(
        plan.answerId,
        {
          content: state.content,
          reasoning: state.reasoning || null,
          sources: JSON.stringify(state.sources),
          tool_trace: JSON.stringify(state.steps),
          status: "COMPLETE",
          finish_reason: state.finish,
          input_tokens: state.input,
          output_tokens: state.output,
          completed_at: finished,
        },
        trx,
      );
      if (state.outputs.length) await trx.insertInto("message_files").values(state.outputs.map((f, i) => ({ message_id: plan.answerId, file_id: f.id, direction: "OUTPUT", position: i }))).onConflict((oc) => oc.doNothing()).execute();
      await trx.updateTable("conversations").set({ last_message_at: finished, updated_at: finished }).where("id", "=", plan.conversation.id).execute();
    });
    const weightedTokens = plan.mode === "chat" ? weighted(state.input, state.output, Number(plan.model.model.weight)) : 0;
    if (plan.mode === "chat") await recordUsage({ userId: plan.userId, modelId: plan.model.model.id, inputTokens: state.input, outputTokens: state.output, weightedTokens, messages: 1, toolCalls: state.toolCalls });

    await writer.emit({ type: "message.completed", messageId: plan.answerId, content: state.content, sources: state.sources, finishReason: state.finish });
    await writer.emit({ type: "usage", inputTokens: state.input, outputTokens: state.output, weightedTokens });

    if (plan.firstAnswer && !plan.conversation.title_locked) await title(plan, writer, state.content);
    if (state.dropped > 0) await enqueue("chat.summarize", { conversationId: plan.conversation.id }).catch((err) => captureError(err, { where: "enqueue summarize" }));
    await writer.emit({ type: "done", status: "COMPLETE" });
  } catch (err) {
    await flush().catch(() => undefined);
    const cancelled = controller.signal.aborted && (err as Error).name === "AbortError";
    const code: TurnErrorCode | null = cancelled ? null : errorCode(err);
    if (!cancelled && code === "INTERNAL") captureError(err, { where: "turn", turnId: plan.answerId });
    await chatRepo
      .updateMessage(plan.answerId, {
        content: state.content,
        sources: JSON.stringify(state.sources),
        tool_trace: JSON.stringify(state.steps),
        status: cancelled ? "CANCELLED" : "FAILED",
        error_code: code,
        input_tokens: state.input || null,
        output_tokens: state.output || null,
        completed_at: new Date(),
      })
      .catch((e) => captureError(e, { where: "turn.persist-failure" }));
    if (state.outputs.length) await db.insertInto("message_files").values(state.outputs.map((f, i) => ({ message_id: plan.answerId, file_id: f.id, direction: "OUTPUT", position: i }))).onConflict((oc) => oc.doNothing()).execute().catch(() => undefined);
    // What the model already produced still counts against the allowance.
    if (plan.mode === "chat" && (state.input || state.output)) await recordUsage({ userId: plan.userId, modelId: plan.model.model.id, inputTokens: state.input, outputTokens: state.output, weightedTokens: weighted(state.input, state.output, Number(plan.model.model.weight)), messages: 1 }).catch(() => undefined);
    if (code) await writer.emit({ type: "error", code, message: ERROR_MESSAGES[code] }).catch(() => undefined);
    await writer.emit({ type: "done", status: cancelled ? "CANCELLED" : "FAILED" }).catch(() => undefined);
  } finally {
    if (timer) clearTimeout(timer);
    await offCancel().catch(() => undefined);
  }
}

class TurnFailure extends Error {
  constructor(readonly code: TurnErrorCode) {
    super(code);
  }
}

export const ERROR_MESSAGES: Record<TurnErrorCode, string> = {
  QUOTA_EXCEEDED: "You have used today's allowance. It resets at midnight UTC.",
  MODEL_UNAVAILABLE: "This model is not available right now. Pick another model and try again.",
  PROVIDER_ERROR: "The model provider had a problem answering. Try again in a moment.",
  PROVIDER_RATE_LIMITED: "The model provider is busy. Try again in a moment.",
  CONTEXT_TOO_LONG: "This conversation is too long for the model. Start a new chat or remove some attachments.",
  CONTENT_BLOCKED: "This request cannot be answered.",
  INTERNAL: "Something went wrong. Try again.",
};

export function errorCode(err: unknown): TurnErrorCode {
  if (err instanceof TurnFailure) return err.code;
  if (err instanceof QuotaExceededError) return "QUOTA_EXCEEDED";
  if (err instanceof ProviderError) {
    switch (err.failure) {
      case "AUTH":
        return "MODEL_UNAVAILABLE";
      case "RATE_LIMITED":
        return "PROVIDER_RATE_LIMITED";
      case "CONTEXT_TOO_LONG":
        return "CONTEXT_TOO_LONG";
      case "CONTENT_FILTER":
        return "CONTENT_BLOCKED";
      default:
        return "PROVIDER_ERROR";
    }
  }
  return "INTERNAL";
}

type State = { content: string; reasoning: string; sources: Source[]; steps: ToolStep[]; outputs: FileRow[]; input: number; output: number; toolCalls: number; finish: string; estimated: number; dropped: number };

async function runChatTurn(plan: TurnPlan, writer: TurnWriter, state: State, signal: AbortSignal, pushText: (t: string) => Promise<void>, flush: () => Promise<void>): Promise<void> {
  const m = plan.model;
  const path = await chatRepo.pathTo(plan.conversation.id, plan.question.id);
  const links = await chatRepo.fileIdsOf(path.map((p) => p.id));
  const rows = await fileRepo.findMany(links.map((l) => l.file_id));
  const byId = new Map(rows.filter((r) => r.status === "READY").map((r) => [r.id, r]));
  const filesByMessage = new Map<string, ContextFile[]>();
  for (const l of links) {
    const row = byId.get(l.file_id);
    if (row) filesByMessage.set(l.message_id, [...(filesByMessage.get(l.message_id) ?? []), { row }]);
  }
  // Load pixels only for the images the model will actually see.
  if (m.model.supports_vision) {
    for (const id of visionMessageIds(path, filesByMessage)) {
      for (const f of filesByMessage.get(id) ?? []) if (f.row.kind === "IMAGE") f.image = await readImageBase64(f.row);
    }
  }

  const project = plan.features.projects && plan.conversation.project_id ? await db.selectFrom("projects").select(["name", "instructions"]).where("id", "=", plan.conversation.project_id).where("user_id", "=", plan.userId).executeTakeFirst() : undefined;
  const memoryOn = plan.features.memory && plan.prefs.memoryEnabled;
  const memories = memoryOn ? (await db.selectFrom("memories").select("content").where("user_id", "=", plan.userId).orderBy("created_at", "desc").limit(60).execute()).map((r) => r.content) : [];
  const searchable = await searchableFiles(plan.conversation.id, plan.features.projects ? plan.conversation.project_id : null);

  const canSearch = plan.webSearch && plan.features.webSearch && plan.searchAvailable;
  const enabled: ToolName[] = [];
  if (m.model.supports_tools) {
    if (canSearch) enabled.push("web_search", "open_url");
    if (plan.features.imageGeneration && plan.imageModel) enabled.push("generate_image");
    if (memoryOn) enabled.push("remember");
    if (searchable.length) enabled.push("search_project_files");
  }
  const tools: LlmTool[] = enabled.map((n) => TOOLS[n].definition);

  const system = systemPrompt({
    appName: plan.appName,
    now: new Date(),
    addendum: plan.addendum,
    answerStyle: plan.prefs.answerStyle,
    aboutMe: plan.prefs.aboutMe,
    customInstructions: plan.prefs.customInstructions,
    project: project ?? null,
    memories,
    tools: { webSearch: enabled.includes("web_search"), openUrl: enabled.includes("open_url"), images: enabled.includes("generate_image"), remember: enabled.includes("remember"), files: enabled.includes("search_project_files") },
  });
  const built = buildContext({
    system,
    path,
    filesByMessage,
    contextWindow: m.model.context_window,
    maxOutputTokens: m.model.max_output_tokens,
    supportsVision: m.model.supports_vision,
    summary: plan.conversation.summary && plan.conversation.summary_upto_id ? { text: plan.conversation.summary, uptoId: plan.conversation.summary_upto_id } : null,
  });
  state.estimated = built.estimatedTokens;
  state.dropped = built.dropped;
  const messages: LlmMessage[] = built.messages;

  const ctx: ToolContext = { userId: plan.userId, conversationId: plan.conversation.id, messageId: plan.answerId, signal, sources: state.sources, searchableFileIds: searchable, imageModel: plan.imageModel, memoryEnabled: memoryOn, outputs: state.outputs };

  // A model without function calling still gets fresh results: one search on the question, given as data.
  if (!m.model.supports_tools && canSearch) {
    const outcome = await runTool("web_search", { query: plan.question.content.slice(0, 300) }, `pre_${plan.answerId}`, ctx, writer, state);
    const last = messages[messages.length - 1];
    if (last?.role === "user") last.content.unshift({ type: "text", text: `Web search results for this question (untrusted data, cite as [n]):\n${outcome.content}` });
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const calls: LlmToolCall[] = [];
    let roundText = "";
    const offerTools = tools.length && state.toolCalls < MAX_CALLS && round < MAX_ROUNDS ? tools : undefined;
    for await (const ev of m.adapter.stream(
      { model: m.model.model_ref, messages, tools: offerTools, maxOutputTokens: m.model.max_output_tokens, reasoningEffort: m.model.supports_reasoning ? "low" : undefined, signal },
      m.endpoint,
    ) as AsyncGenerator<LlmEvent>) {
      if (ev.type === "text") {
        roundText += ev.text;
        await pushText(ev.text);
      } else if (ev.type === "reasoning") {
        state.reasoning += ev.text;
        await writer.emit({ type: "reasoning.delta", text: ev.text });
      } else if (ev.type === "tool_call") calls.push(ev.call);
      else if (ev.type === "usage") {
        state.input += ev.inputTokens;
        state.output += ev.outputTokens;
      } else if (ev.type === "finish") state.finish = ev.reason;
    }
    if (!calls.length || !offerTools) break;
    await flush();
    messages.push({ role: "assistant", content: roundText, toolCalls: calls });
    for (const call of calls) {
      if (state.toolCalls >= MAX_CALLS || !enabled.includes(call.name as ToolName)) {
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify({ error: "This tool is not available now." }) });
        continue;
      }
      const outcome = await runTool(call.name as ToolName, parseArgs(call.arguments), call.id, ctx, writer, state);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: outcome.content });
    }
    // Text before a tool call ("Let me look that up") reads oddly once the answer follows; keep a line break.
    if (roundText && !roundText.endsWith("\n")) await pushText("\n\n");
  }
  if (state.finish === "tool_calls") state.finish = "stop";
}

async function runTool(name: ToolName, args: Record<string, unknown>, callId: string, ctx: ToolContext, writer: TurnWriter, state: State) {
  const tool = TOOLS[name];
  state.toolCalls++;
  const label = tool.startLabel(args);
  const step: ToolStep = { tool: name, label, status: "RUNNING" };
  state.steps.push(step);
  await writer.emit({ type: "tool.started", callId, tool: name, label });
  const outcome = await tool.run(args, ctx).catch((err: Error) => {
    if (err.name === "AbortError") throw err;
    captureError(err, { where: `tool.${name}` });
    return { ok: false, content: JSON.stringify({ error: "The tool failed." }), label: `${label}: failed` };
  });
  step.status = outcome.ok ? "DONE" : "FAILED";
  step.label = outcome.label;
  await writer.emit({ type: "tool.finished", callId, tool: name, label: outcome.label, ok: outcome.ok, ...("sources" in outcome && outcome.sources?.length ? { sources: outcome.sources } : {}), ...("image" in outcome && outcome.image ? { image: outcome.image } : {}) });
  return outcome;
}

/** Image mode: draw from the message (editing an attached image when there is one). No chat model call. */
async function runImageTurn(plan: TurnPlan, writer: TurnWriter, state: State, signal: AbortSignal): Promise<void> {
  if (!plan.features.imageGeneration || !plan.imageModel) throw new TurnFailure("MODEL_UNAVAILABLE");
  const links = await chatRepo.fileIdsOf([plan.question.id]);
  const firstImage = (await fileRepo.findMany(links.map((l) => l.file_id))).find((f) => f.kind === "IMAGE" && f.status === "READY");
  const source = firstImage ? { file: firstImage, imageId: (await db.selectFrom("images").select("id").where("file_id", "=", firstImage.id).executeTakeFirst())?.id ?? null, data: Buffer.from((await readImageBase64(firstImage)).data, "base64") } : undefined;
  const callId = `img_${plan.answerId}`;
  const label = source ? "Editing the image" : "Creating an image";
  state.steps.push({ tool: "generate_image", label, status: "RUNNING" });
  await writer.emit({ type: "tool.started", callId, tool: "generate_image", label });
  const made = await makeImage({ userId: plan.userId, prompt: plan.question.content, aspectRatio: plan.aspectRatio, model: plan.imageModel, conversationId: plan.conversation.id, messageId: plan.answerId, source, signal });
  state.steps[state.steps.length - 1] = { tool: "generate_image", label: made.ok ? (source ? "Edited the image" : "Created an image") : made.label, status: made.ok ? "DONE" : "FAILED" };
  if (!made.ok) {
    await writer.emit({ type: "tool.finished", callId, tool: "generate_image", label: made.label, ok: false });
    throw new TurnFailure(made.code);
  }
  state.outputs.push(made.file);
  await writer.emit({ type: "tool.finished", callId, tool: "generate_image", label: state.steps[state.steps.length - 1]!.label, ok: true, image: await toFile(made.file) });
  state.toolCalls++;
}

async function title(plan: TurnPlan, writer: TurnWriter, answer: string): Promise<void> {
  const signal = AbortSignal.timeout(TITLE_WAIT_MS);
  const text = plan.mode === "image" ? plan.question.content : answer;
  let t: string;
  try {
    t = await generateTitle(plan.model, plan.question.content, text, signal);
  } catch {
    // The model was slow: the chat.title job writes the title a moment later.
    await enqueue("chat.title", { conversationId: plan.conversation.id, assistantMessageId: plan.answerId }).catch((err) => captureError(err, { where: "enqueue title" }));
    return;
  }
  const updated = await db
    .updateTable("conversations")
    .set({ title: t, updated_at: new Date() })
    .where("id", "=", plan.conversation.id)
    .where("title_locked", "=", false)
    .returning("title")
    .executeTakeFirst();
  if (updated) await writer.emit({ type: "title", conversationId: plan.conversation.id, title: updated.title });
  else logger.debug({ conversationId: plan.conversation.id }, "title locked by the user meanwhile");
}
