/** The image studio (outside a chat) and the gallery of everything a user generated. */
import type { AspectRatio, GeneratedImage, Page } from "@open-chat/types";
import { type Actor, requireActive } from "../core/context";
import { badRequest, HttpError, notFound } from "../core/errors";
import { db } from "../db/kysely";
import { consume } from "../middleware/rate-limit";
import { loadFiles } from "../presenters/file.presenter";
import { atKey, decodeTime, olderThan, timePage } from "../repositories/keyset";
import { makeImage } from "./chat/tools";
import { readImageBase64 } from "./file.service";
import { fileRepo } from "../repositories/file.repository";
import { resolveKind } from "./models.service";
import { getSettings } from "./settings.service";

type Row = { id: string; prompt: string; aspect_ratio: string; file_id: string; model_id: string | null; conversation_id: string | null; source_image_id: string | null; created_at: Date; model_name: string | null };

async function present(rows: Row[]): Promise<GeneratedImage[]> {
  const files = await loadFiles(rows.map((r) => r.file_id));
  return rows
    .filter((r) => files.has(r.file_id))
    .map((r) => ({
      id: r.id,
      prompt: r.prompt,
      aspectRatio: r.aspect_ratio as AspectRatio,
      file: files.get(r.file_id)!,
      model: r.model_id ? { id: r.model_id, displayName: r.model_name ?? "Removed model" } : null,
      conversationId: r.conversation_id,
      sourceImageId: r.source_image_id,
      createdAt: r.created_at.toISOString(),
    }));
}

function base() {
  return db.selectFrom("images as i").leftJoin("models as m", "m.id", "i.model_id").select(["i.id", "i.prompt", "i.aspect_ratio", "i.file_id", "i.model_id", "i.conversation_id", "i.source_image_id", "i.created_at", "m.display_name as model_name"]);
}

export async function listImages(actor: Actor, cursor?: string, limit = 30): Promise<Page<GeneratedImage>> {
  const rows = await base().select(atKey("i.created_at")).where("i.user_id", "=", actor.id).where(olderThan("i.created_at", "i.id", decodeTime(cursor))).orderBy("i.created_at", "desc").orderBy("i.id", "desc").limit(Math.min(limit, 60) + 1).execute();
  const page = timePage(rows, Math.min(limit, 60));
  return { items: await present(page.items), nextCursor: page.nextCursor };
}

/** Generate in the studio; `sourceImageId` edits one of your gallery images. */
export async function createImage(actor: Actor, input: { prompt: string; aspectRatio: AspectRatio; sourceImageId?: string }): Promise<GeneratedImage> {
  requireActive(actor);
  await consume("images", `u:${actor.id}`, 10, 60);
  if (!(await getSettings()).features.imageGeneration) throw badRequest("Image generation is turned off", "IMAGES_UNAVAILABLE");
  let source: { file: Awaited<ReturnType<typeof fileRepo.findById>> & object; imageId: string; data: Buffer } | undefined;
  if (input.sourceImageId) {
    const img = await db.selectFrom("images").select(["id", "file_id"]).where("id", "=", input.sourceImageId).where("user_id", "=", actor.id).executeTakeFirst();
    if (!img) throw notFound("Image not found", "IMAGE_NOT_FOUND");
    const file = await fileRepo.findById(img.file_id);
    if (!file || file.status !== "READY") throw notFound("Image not found", "IMAGE_NOT_FOUND");
    source = { file, imageId: img.id, data: Buffer.from((await readImageBase64(file)).data, "base64") };
  }
  const made = await makeImage({ userId: actor.id, prompt: input.prompt, aspectRatio: input.aspectRatio, model: await resolveKind("IMAGE"), conversationId: null, messageId: null, source });
  if (!made.ok) {
    if (made.code === "QUOTA_EXCEEDED") throw new HttpError(429, made.error, "QUOTA_EXCEEDED");
    if (made.code === "CONTENT_BLOCKED") throw badRequest(made.error, "CONTENT_BLOCKED");
    if (made.code === "MODEL_UNAVAILABLE") throw new HttpError(503, made.error, "MODEL_UNAVAILABLE");
    throw new HttpError(502, made.error, "PROVIDER_ERROR");
  }
  const row = await base().where("i.id", "=", made.imageId).executeTakeFirstOrThrow();
  return (await present([row]))[0]!;
}

/** Remove from the gallery. An image shown in a chat stays in that chat. */
export async function deleteImage(actor: Actor, id: string): Promise<void> {
  const res = await db.deleteFrom("images").where("id", "=", id).where("user_id", "=", actor.id).executeTakeFirst();
  if (!Number(res.numDeletedRows)) throw notFound("Image not found", "IMAGE_NOT_FOUND");
}
