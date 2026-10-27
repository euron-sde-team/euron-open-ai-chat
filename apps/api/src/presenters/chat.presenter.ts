/** Conversations and messages to DTOs, batched: one query each for files, models and siblings. */
import type { ConversationSummary, Message, Source, ToolStep } from "@open-chat/types";
import { db } from "../db/kysely";
import { chatRepo, type ConversationRow, type MessageRow } from "../repositories/chat.repository";
import { loadFiles } from "./file.presenter";

export function toSummary(c: ConversationRow): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    projectId: c.project_id,
    pinned: !!c.pinned_at,
    archived: !!c.archived_at,
    lastMessageAt: c.last_message_at.toISOString(),
    createdAt: c.created_at.toISOString(),
  };
}

export async function toMessages(conversationId: string, rows: MessageRow[]): Promise<Message[]> {
  if (!rows.length) return [];
  const [links, siblings, models] = await Promise.all([
    chatRepo.fileIdsOf(rows.map((r) => r.id)),
    chatRepo.siblingsOf(
      conversationId,
      rows.map((r) => r.parent_id),
    ),
    loadModelNames(rows.map((r) => r.model_id)),
  ]);
  const files = await loadFiles(links.map((l) => l.file_id));
  return rows.map((r) => {
    const mine = links.filter((l) => l.message_id === r.id);
    const pick = (dir: string) => mine.filter((l) => l.direction === dir).map((l) => files.get(l.file_id)).filter((f): f is NonNullable<typeof f> => !!f);
    return {
      id: r.id,
      conversationId: r.conversation_id,
      parentId: r.parent_id,
      role: r.role,
      content: r.content,
      reasoning: r.reasoning,
      sources: (r.sources as unknown as Source[]) ?? [],
      toolSteps: (r.tool_trace as unknown as ToolStep[]) ?? [],
      attachments: pick("INPUT"),
      outputs: pick("OUTPUT"),
      model: r.model_id ? { id: r.model_id, displayName: models.get(r.model_id) ?? "Removed model" } : null,
      status: r.status,
      errorCode: r.error_code,
      feedback: r.feedback === 1 || r.feedback === -1 ? r.feedback : null,
      webSearch: r.web_search,
      siblingIds: siblings.get(r.parent_id ?? "") ?? [r.id],
      createdAt: r.created_at.toISOString(),
      completedAt: r.completed_at?.toISOString() ?? null,
    };
  });
}

async function loadModelNames(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const rows = await db.selectFrom("models").select(["id", "display_name"]).where("id", "in", wanted).execute();
  return new Map(rows.map((r) => [r.id, r.display_name]));
}
