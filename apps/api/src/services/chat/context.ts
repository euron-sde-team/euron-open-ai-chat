/**
 * What a model sees for one turn: the system prompt, then the conversation branch from
 * the root to the new question, fitted to the model's context window.
 *
 * Budget = context_window - max_output_tokens - headroom for tools. Messages are taken
 * newest first until the budget is spent. Turns that no longer fit are represented by the
 * conversation's rolling summary (the chat.summarize job keeps it current), and only when
 * that summary was written for this branch (summary_upto_id is on the path).
 *
 * Attachments:
 *   - images become image parts for vision models (only on the two most recent user
 *     messages that carry images; older ones and non-vision models get a short note);
 *   - documents on the newest message are included as text up to DOC_SHARE of the budget,
 *     cut at a line break with a note that the rest is searchable; documents on older
 *     messages are named only, and search_project_files reaches all of them.
 */
import type { AnswerStyle } from "@open-chat/types";
import { estimateTokens } from "../../domain/chunking";
import type { LlmMessage, LlmPart } from "../../integrations/llm";
import type { FileRow } from "../../repositories/file.repository";
import type { MessageRow } from "../../repositories/chat.repository";

export const TOOL_HEADROOM_TOKENS = 1500;
/** Image parts cost roughly this many tokens on most vision models (a 1024px image). */
export const IMAGE_TOKENS = 1100;
const DOC_SHARE = 0.6;
const VISION_RECENT_MESSAGES = 2;

export interface ContextFile {
  row: FileRow;
  /** base64, loaded only for images the model will see. */
  image?: { data: string; mimeType: string };
}

export interface BuildInput {
  system: string;
  path: MessageRow[];
  filesByMessage: Map<string, ContextFile[]>;
  contextWindow: number;
  maxOutputTokens: number;
  supportsVision: boolean;
  summary: { text: string; uptoId: string } | null;
}

export interface BuiltContext {
  messages: LlmMessage[];
  /** How many messages after the summary point did not fit (0 when everything fits). */
  dropped: number;
  /** Whether a summary stood in for the dropped turns. */
  usedSummary: boolean;
  estimatedTokens: number;
}

/** Which images a vision model gets as pixels: the most recent user messages with images. */
export function visionMessageIds(path: MessageRow[], filesByMessage: Map<string, ContextFile[]>): Set<string> {
  const ids: string[] = [];
  for (let i = path.length - 1; i >= 0 && ids.length < VISION_RECENT_MESSAGES; i--) {
    const m = path[i]!;
    if (m.role === "USER" && (filesByMessage.get(m.id) ?? []).some((f) => f.row.kind === "IMAGE")) ids.push(m.id);
  }
  return new Set(ids);
}

export function buildContext(input: BuildInput): BuiltContext {
  const budget = Math.max(2000, input.contextWindow - input.maxOutputTokens - TOOL_HEADROOM_TOKENS);
  let used = estimateTokens(input.system);
  const vision = input.supportsVision ? visionMessageIds(input.path, input.filesByMessage) : new Set<string>();
  const newest = input.path[input.path.length - 1];

  // The summary only applies to this branch if the message it covers up to is on the path.
  const summaryIdx = input.summary ? input.path.findIndex((m) => m.id === input.summary!.uptoId) : -1;
  const candidates = summaryIdx >= 0 ? input.path.slice(summaryIdx + 1) : input.path;
  const summaryText = summaryIdx >= 0 ? `Summary of the earlier part of this conversation:\n${input.summary!.text}` : null;
  if (summaryText) used += estimateTokens(summaryText);

  const out: LlmMessage[] = [];
  let taken = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const m = candidates[i]!;
    const files = input.filesByMessage.get(m.id) ?? [];
    const isNewest = m.id === newest?.id;
    const msg = m.role === "USER" ? userMessage(m, files, vision.has(m.id), isNewest, Math.floor((budget - used) * DOC_SHARE)) : assistantMessage(m, files);
    const cost = messageTokens(msg);
    // The newest message is always sent, even if it alone is over budget (the provider decides).
    if (!isNewest && used + cost > budget) break;
    used += cost;
    out.unshift(msg);
    taken++;
  }
  // Messages after the summary point that still did not fit: the summary job should move forward.
  const dropped = candidates.length - taken;
  const system = summaryText ? `${input.system}\n\n${summaryText}` : input.system;
  return { messages: [{ role: "system", content: system }, ...out], dropped, usedSummary: !!summaryText, estimatedTokens: used };
}

function userMessage(m: MessageRow, files: ContextFile[], seeImages: boolean, isNewest: boolean, docBudgetTokens: number): LlmMessage {
  const parts: LlmPart[] = [];
  const notes: string[] = [];
  let docTokens = 0;
  for (const f of files) {
    const r = f.row;
    if (r.kind === "IMAGE") {
      if (seeImages && f.image) parts.push({ type: "image", data: f.image.data, mimeType: f.image.mimeType });
      else notes.push(`[Image attached: ${r.file_name}${seeImages ? "" : " (not visible to you in this message)"}]`);
      continue;
    }
    const text = r.extracted_text ?? "";
    if (isNewest && text) {
      const room = docBudgetTokens - docTokens;
      if (room > 500) {
        const cost = estimateTokens(text);
        if (cost <= room) {
          parts.push({ type: "text", text: fileBlock(r.file_name, text, false) });
          docTokens += cost;
        } else {
          const cut = text.slice(0, room * 4);
          const at = cut.lastIndexOf("\n");
          parts.push({ type: "text", text: fileBlock(r.file_name, at > room * 3 ? cut.slice(0, at) : cut, true) });
          docTokens = docBudgetTokens;
        }
        continue;
      }
    }
    notes.push(`[File attached: ${r.file_name}${r.page_count ? `, ${r.page_count} pages` : ""}. Use search_project_files to read it.]`);
  }
  const text = [notes.join("\n"), m.content].filter(Boolean).join("\n\n");
  return { role: "user", content: [...parts, { type: "text", text: text || "(no text)" }] };
}

function fileBlock(name: string, text: string, truncated: boolean): string {
  return `<file name="${name.replace(/"/g, "'")}">\n${text}\n</file>${truncated ? `\n[The rest of ${name} did not fit; use search_project_files to find passages in it.]` : ""}`;
}

function assistantMessage(m: MessageRow, files: ContextFile[]): LlmMessage {
  const made = files.filter((f) => f.row.kind === "IMAGE").map((f) => `[You generated an image: ${f.row.file_name}]`);
  const content = [m.content, ...made].filter(Boolean).join("\n\n");
  return { role: "assistant", content: content || (m.status === "FAILED" ? "(this answer failed)" : "") };
}

function messageTokens(m: LlmMessage): number {
  if (m.role === "user") return m.content.reduce((n, p) => n + (p.type === "text" ? estimateTokens(p.text) : IMAGE_TOKENS), 4);
  if (m.role === "assistant") return estimateTokens(m.content) + 4;
  if (m.role === "tool") return estimateTokens(m.content) + 4;
  return estimateTokens(m.content);
}

/** The answer-style instruction a user's preference maps to (re-exported for tests). */
export type { AnswerStyle };
