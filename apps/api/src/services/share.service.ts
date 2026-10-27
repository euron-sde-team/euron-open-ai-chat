/**
 * Shared links (ADR 0010). Sharing freezes the branch on screen into a snapshot: later
 * messages never appear, and deleting the conversation does not change what the link
 * shows (revoke the link for that). The snapshot keeps text, sources, model names and
 * which images to show; attachments other than images appear by name only, never their
 * contents or storage keys. Images are served by a route that only knows the file ids
 * frozen into the snapshot.
 *
 * Link ids are 128 random bits (not ULIDs, which carry a timestamp and less randomness).
 */
import crypto from "node:crypto";
import type { Share, SharedConversation, SharedMessage, Source } from "@open-chat/types";
import { config } from "../core/config";
import { type Actor, requireActive } from "../core/context";
import { badRequest, forbidden, notFound } from "../core/errors";
import { db } from "../db/kysely";
import { storage } from "../integrations/storage";
import { chatRepo } from "../repositories/chat.repository";
import { fileRepo } from "../repositories/file.repository";
import { getSettings } from "./settings.service";

export const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;

interface SnapshotMessage {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  sources: Source[];
  imageFileIds: string[];
  attachmentNames: string[];
  model: string | null;
  createdAt: string;
}

type ShareRow = { id: string; title: string; conversation_id: string | null; view_count: number; revoked_at: Date | null; expires_at: Date | null; created_at: Date };

export function shareUrl(id: string): string {
  return `${config.APP_WEB_URL.replace(/\/$/, "")}/share/${id}`;
}

function toShare(r: ShareRow): Share {
  return { id: r.id, title: r.title, conversationId: r.conversation_id, url: shareUrl(r.id), viewCount: r.view_count, revoked: !!r.revoked_at, expiresAt: r.expires_at?.toISOString() ?? null, createdAt: r.created_at.toISOString() };
}

export async function createShare(actor: Actor, conversationId: string, input: { expiresInDays?: number | null }): Promise<Share> {
  requireActive(actor);
  if (!(await getSettings()).features.sharing) throw forbidden("Sharing is turned off", "SHARING_DISABLED");
  const c = await chatRepo.findConversation(actor.id, conversationId);
  if (!c) throw notFound("Conversation not found", "CONVERSATION_NOT_FOUND");
  const path = (await chatRepo.pathTo(c.id, c.current_leaf_id)).filter((m) => m.status === "COMPLETE" || m.role === "USER");
  if (!path.some((m) => m.role === "ASSISTANT")) throw badRequest("There is nothing to share yet", "SHARE_EMPTY");
  const links = await chatRepo.fileIdsOf(path.map((m) => m.id));
  const files = new Map((await fileRepo.findMany(links.map((l) => l.file_id))).map((f) => [f.id, f]));
  const models = new Map((await db.selectFrom("models").select(["id", "display_name"]).execute()).map((m) => [m.id, m.display_name]));
  const snapshot: SnapshotMessage[] = path.map((m) => {
    const mine = links.filter((l) => l.message_id === m.id).map((l) => files.get(l.file_id)).filter((f): f is NonNullable<typeof f> => !!f && f.status === "READY");
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      sources: (m.sources as unknown as Source[]) ?? [],
      imageFileIds: mine.filter((f) => f.kind === "IMAGE").map((f) => f.id),
      attachmentNames: mine.filter((f) => f.kind !== "IMAGE").map((f) => f.file_name),
      model: m.model_id ? (models.get(m.model_id) ?? null) : null,
      createdAt: m.created_at.toISOString(),
    };
  });
  const id = crypto.randomBytes(16).toString("base64url");
  const row = await db
    .insertInto("shares")
    .values({
      id,
      user_id: actor.id,
      conversation_id: c.id,
      title: c.title,
      snapshot: JSON.stringify(snapshot),
      file_ids: snapshot.flatMap((m) => m.imageFileIds),
      expires_at: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    })
    .returning(["id", "title", "conversation_id", "view_count", "revoked_at", "expires_at", "created_at"])
    .executeTakeFirstOrThrow();
  return toShare(row);
}

export async function listShares(actor: Actor): Promise<Share[]> {
  const rows = await db.selectFrom("shares").select(["id", "title", "conversation_id", "view_count", "revoked_at", "expires_at", "created_at"]).where("user_id", "=", actor.id).orderBy("created_at", "desc").limit(200).execute();
  return rows.map(toShare);
}

export async function revokeShare(actor: Actor, id: string): Promise<void> {
  const res = await db.updateTable("shares").set({ revoked_at: new Date(), revoked_by: actor.id }).where("id", "=", id).where("user_id", "=", actor.id).where("revoked_at", "is", null).executeTakeFirst();
  if (!Number(res.numUpdatedRows)) throw notFound("Link not found", "SHARE_NOT_FOUND");
}

async function liveShare(id: string) {
  if (!SHARE_ID.test(id)) throw notFound("This link does not exist or was removed", "SHARE_NOT_FOUND");
  const row = await db
    .selectFrom("shares as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .select(["s.id", "s.title", "s.snapshot", "s.file_ids", "s.created_at", "s.expires_at", "s.revoked_at", "u.display_name", "u.status"])
    .where("s.id", "=", id)
    .executeTakeFirst();
  if (!row || row.revoked_at || (row.expires_at && row.expires_at < new Date()) || row.status === "BANNED" || row.status === "DEACTIVATED" || !(await getSettings()).features.sharing) {
    throw notFound("This link does not exist or was removed", "SHARE_NOT_FOUND");
  }
  return row;
}

/** The public page's data. Anyone with the link; counts a view. */
export async function readShared(id: string): Promise<SharedConversation> {
  const row = await liveShare(id);
  await db.updateTable("shares").set((eb) => ({ view_count: eb("view_count", "+", 1) })).where("id", "=", id).execute();
  const files = new Map((await fileRepo.findMany(row.file_ids)).map((f) => [f.id, f]));
  const api = config.PUBLIC_API_URL.replace(/\/$/, "");
  const messages: SharedMessage[] = (row.snapshot as unknown as SnapshotMessage[]).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    sources: m.sources,
    images: m.imageFileIds.filter((fid) => files.has(fid)).map((fid) => ({ url: `${api}/api/shared/${id}/images/${fid}`, width: files.get(fid)!.width, height: files.get(fid)!.height })),
    attachmentNames: m.attachmentNames,
    model: m.model,
    createdAt: m.createdAt,
  }));
  return { id: row.id, title: row.title, sharedBy: row.display_name, createdAt: row.created_at.toISOString(), messages };
}

/** A short-lived URL for one image of a share, only if that image is frozen into it. */
export async function sharedImageUrl(id: string, fileId: string): Promise<string> {
  const row = await liveShare(id);
  if (!row.file_ids.includes(fileId)) throw notFound();
  const file = await fileRepo.findById(fileId);
  if (!file || file.kind !== "IMAGE" || file.status === "DELETED") throw notFound();
  return storage().signedGetUrl(file.storage_key);
}
