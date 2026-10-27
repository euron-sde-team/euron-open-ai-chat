/**
 * Conversations and the message tree. Every read is scoped by user_id in the query
 * itself, so a conversation id from another account simply finds nothing.
 */
import { sql, type Insertable, type Selectable, type Updateable } from "kysely";
import { db, type Executor } from "../db/kysely";
import type { Conversations, Messages } from "../db/types";

export type ConversationRow = Selectable<Conversations>;
export type MessageRow = Selectable<Messages>;

export class ChatRepository {
  findConversation(userId: string, id: string, exec: Executor = db) {
    return exec.selectFrom("conversations").selectAll().where("id", "=", id).where("user_id", "=", userId).executeTakeFirst();
  }

  /** Jobs only: no user scope. */
  findConversationById(id: string, exec: Executor = db) {
    return exec.selectFrom("conversations").selectAll().where("id", "=", id).executeTakeFirst();
  }

  insertConversation(row: Insertable<Conversations>, exec: Executor = db) {
    return exec.insertInto("conversations").values(row).returningAll().executeTakeFirstOrThrow();
  }

  updateConversation(id: string, patch: Updateable<Conversations>, exec: Executor = db) {
    return exec.updateTable("conversations").set({ ...patch, updated_at: new Date() }).where("id", "=", id).returningAll().executeTakeFirst();
  }

  insertMessage(row: Insertable<Messages>, exec: Executor = db) {
    return exec.insertInto("messages").values(row).returningAll().executeTakeFirstOrThrow();
  }

  updateMessage(id: string, patch: Updateable<Messages>, exec: Executor = db) {
    return exec.updateTable("messages").set(patch).where("id", "=", id).returningAll().executeTakeFirst();
  }

  findMessage(id: string, exec: Executor = db) {
    return exec.selectFrom("messages").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** A message together with its conversation, only if the conversation is the user's. */
  findOwnedMessage(userId: string, messageId: string, exec: Executor = db) {
    return exec
      .selectFrom("messages as m")
      .innerJoin("conversations as c", "c.id", "m.conversation_id")
      .selectAll("m")
      .select(["c.user_id"])
      .where("m.id", "=", messageId)
      .where("c.user_id", "=", userId)
      .executeTakeFirst();
  }

  /** The branch from the root to `leafId`, oldest first. */
  async pathTo(conversationId: string, leafId: string | null, exec: Executor = db): Promise<MessageRow[]> {
    if (!leafId) return [];
    const res = await sql<MessageRow>`
      WITH RECURSIVE path AS (
        SELECT m.*, 0 AS depth FROM messages m WHERE m.id = ${leafId} AND m.conversation_id = ${conversationId}
        UNION ALL
        SELECT p.*, path.depth + 1 FROM messages p JOIN path ON p.id = path.parent_id
      )
      SELECT * FROM path ORDER BY depth DESC`.execute(exec);
    return res.rows.map(({ depth: _d, ...m }: MessageRow & { depth?: number }) => m as MessageRow);
  }

  /** Children ids of each parent (and the roots under null), oldest first, for sibling switchers. */
  async siblingsOf(conversationId: string, parentIds: readonly (string | null)[], exec: Executor = db): Promise<Map<string, string[]>> {
    const wanted = [...new Set(parentIds.filter((x): x is string => !!x))];
    const wantRoots = parentIds.some((p) => p === null);
    const rows = await exec
      .selectFrom("messages")
      .select(["id", "parent_id"])
      .where("conversation_id", "=", conversationId)
      .where((eb) => eb.or([...(wanted.length ? [eb("parent_id", "in", wanted)] : []), ...(wantRoots ? [eb("parent_id", "is", null)] : [eb.val(false)])]))
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const k = r.parent_id ?? "";
      out.set(k, [...(out.get(k) ?? []), r.id]);
    }
    return out;
  }

  /** The deepest descendant reached by always taking the newest child (switching to a branch shows its latest end). */
  async newestLeafUnder(messageId: string, exec: Executor = db): Promise<string> {
    const res = await sql<{ id: string }>`
      WITH RECURSIVE walk AS (
        SELECT id, 0 AS depth FROM messages WHERE id = ${messageId}
        UNION ALL
        SELECT c.id, walk.depth + 1 FROM walk
        JOIN LATERAL (SELECT id FROM messages WHERE parent_id = walk.id ORDER BY created_at DESC, id DESC LIMIT 1) c ON true
      )
      SELECT id FROM walk ORDER BY depth DESC LIMIT 1`.execute(exec);
    return res.rows[0]?.id ?? messageId;
  }

  async fileIdsOf(messageIds: readonly string[], exec: Executor = db): Promise<{ message_id: string; file_id: string; direction: string; position: number }[]> {
    if (!messageIds.length) return [];
    return exec.selectFrom("message_files").selectAll().where("message_id", "in", [...messageIds]).orderBy("position").execute();
  }

  /** A turn still running in this conversation. */
  findStreaming(conversationId: string, exec: Executor = db) {
    return exec.selectFrom("messages").select(["id"]).where("conversation_id", "=", conversationId).where("status", "=", "STREAMING").executeTakeFirst();
  }
}

export const chatRepo = new ChatRepository();
