/** Saved memories: the user sees, edits and deletes every one; the assistant adds them with the remember tool. */
import type { Memory } from "@open-chat/types";
import { type Actor, requireActive } from "../core/context";
import { conflict, notFound } from "../core/errors";
import { newId } from "../core/ids";
import { db } from "../db/kysely";
import { MAX_MEMORIES } from "./chat/tools";

type Row = { id: string; content: string; source: "USER" | "ASSISTANT"; created_at: Date; updated_at: Date };
const toMemory = (r: Row): Memory => ({ id: r.id, content: r.content, source: r.source, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() });

export async function listMemories(actor: Actor): Promise<Memory[]> {
  const rows = await db.selectFrom("memories").select(["id", "content", "source", "created_at", "updated_at"]).where("user_id", "=", actor.id).orderBy("created_at", "desc").execute();
  return rows.map(toMemory);
}

export async function addMemory(actor: Actor, content: string): Promise<Memory> {
  requireActive(actor);
  const count = await db.selectFrom("memories").select((eb) => eb.fn.countAll<string>().as("n")).where("user_id", "=", actor.id).executeTakeFirstOrThrow();
  if (Number(count.n) >= MAX_MEMORIES) throw conflict(`You can keep at most ${MAX_MEMORIES} memories`, "MEMORY_LIMIT");
  const row = await db.insertInto("memories").values({ id: newId(), user_id: actor.id, content: content.trim(), source: "USER" }).returning(["id", "content", "source", "created_at", "updated_at"]).executeTakeFirstOrThrow();
  return toMemory(row);
}

export async function updateMemory(actor: Actor, id: string, content: string): Promise<Memory> {
  requireActive(actor);
  const row = await db.updateTable("memories").set({ content: content.trim(), updated_at: new Date() }).where("id", "=", id).where("user_id", "=", actor.id).returning(["id", "content", "source", "created_at", "updated_at"]).executeTakeFirst();
  if (!row) throw notFound("Memory not found", "MEMORY_NOT_FOUND");
  return toMemory(row);
}

export async function deleteMemory(actor: Actor, id: string): Promise<void> {
  const res = await db.deleteFrom("memories").where("id", "=", id).where("user_id", "=", actor.id).executeTakeFirst();
  if (!Number(res.numDeletedRows)) throw notFound("Memory not found", "MEMORY_NOT_FOUND");
}

export async function clearMemories(actor: Actor): Promise<void> {
  await db.deleteFrom("memories").where("user_id", "=", actor.id).execute();
}
