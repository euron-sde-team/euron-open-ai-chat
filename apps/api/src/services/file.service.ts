/**
 * Files: the client asks for a presigned PUT, uploads straight to storage, then calls
 * complete. Nothing the client says about the file is trusted past the first step: on
 * complete we HEAD the stored object (size must equal what was declared) and sniff its
 * first bytes (must match the declared type). The files.process job then
 *   - re-encodes images (auto-rotate, EXIF and GPS dropped, at most 2048px on the long
 *     edge, which is also what vision models want) and writes a 512px thumbnail;
 *   - reads text out of documents, caps it, and cuts it into passages for search.
 * Only then is a file READY. A file is only ever visible to its owner; shares serve the
 * files frozen into their snapshot through their own route (share.service.ts).
 *
 * Clients reference files by id. The API never accepts a storage key from a client
 * (the legacy chat did, and let anyone read any object in the bucket).
 */
import type { ChatFile, FilePurpose, UploadTicket } from "@open-chat/types";
import sharp from "sharp";
import { type Actor, requireActive } from "../core/context";
import { withEffects } from "../core/effects";
import { badRequest, conflict, HttpError, notFound } from "../core/errors";
import { newId } from "../core/ids";
import { captureError, logger } from "../core/logger";
import { db, type Executor } from "../db/kysely";
import { capText, chunkText, cleanExtracted, estimateTokens } from "../domain/chunking";
import { checkDeclared, cleanFileName, sniffMatches, storageKeyFor, storedMimeType } from "../domain/file-rules";
import { extractTextFrom } from "../integrations/extract";
import { storage } from "../integrations/storage";
import { consume } from "../middleware/rate-limit";
import { toFile } from "../presenters/file.presenter";
import { fileRepo, type FileRow } from "../repositories/file.repository";
import { limitsFor } from "./quota.service";

const SNIFF_BYTES = 4096;
export const HEIC_UNSUPPORTED = "HEIC photos cannot be processed on this server; export the photo as JPEG and upload it again";
const IMAGE_MAX_EDGE = 2048;
const THUMB_EDGE = 512;
/** Extracted text kept per file. Longer documents are still searchable chunk by chunk up to this. */
export const MAX_EXTRACTED_CHARS = 400_000;

export interface CreateFileInput {
  purpose: Exclude<FilePurpose, "GENERATED">;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export async function createFile(actor: Actor, input: CreateFileInput): Promise<UploadTicket> {
  requireActive(actor);
  const { maxFileMb } = await limitsFor(actor.id);
  const check = checkDeclared({ ...input, maxBytes: maxFileMb * 1024 * 1024 });
  if (!check.ok) {
    throw check.code === "FILE_TOO_LARGE" ? new HttpError(413, check.message, check.code, check.details) : badRequest(check.message, check.code, check.details);
  }
  await consume("file-upload", `u:${actor.id}`, 200, 3600);
  const id = newId();
  const key = storageKeyFor(input.purpose, id, check.ext);
  const row = await fileRepo.insert({
    id,
    owner_id: actor.id,
    purpose: input.purpose,
    kind: check.kind,
    mime_type: check.mimeType,
    file_name: cleanFileName(input.fileName),
    declared_size: input.sizeBytes,
    storage_key: key,
  });
  const put = await storage().presignPut(key, storedMimeType(check.mimeType), input.sizeBytes);
  return { file: await toFile(row), uploadUrl: put.url, headers: put.headers, expiresAt: put.expiresAt };
}

/** The actor's own file, or 404 (never 403: another user's file id is indistinguishable from a missing one). */
export async function ownFile(actor: Actor, id: string, exec: Executor = db): Promise<FileRow> {
  const row = await fileRepo.findById(id, exec);
  if (!row || row.owner_id !== actor.id || row.status === "DELETED") throw notFound("File not found", "FILE_NOT_FOUND");
  return row;
}

async function reject(row: FileRow, reason: string): Promise<void> {
  await fileRepo.update(row.id, { status: "REJECTED", rejected_reason: reason.slice(0, 200) });
  await storage()
    .delete(row.storage_key)
    .catch((err) => captureError(err, { where: "files.reject.delete", fileId: row.id }));
}

/** Verify what landed in storage, then hand the file to the processing job. */
export async function completeFile(actor: Actor, id: string): Promise<ChatFile> {
  requireActive(actor);
  const row = await ownFile(actor, id);
  if (row.status !== "PENDING") return toFile(row);

  const store = storage();
  const head = await store.head(row.storage_key);
  if (!head) throw badRequest("The file has not been uploaded yet", "UPLOAD_MISSING");
  if (head.sizeBytes !== Number(row.declared_size)) {
    await reject(row, "The uploaded file does not match its declared size");
    throw badRequest("The uploaded file does not match the declared size", "FILE_SIZE_MISMATCH");
  }
  const start = await store.readStart(row.storage_key, SNIFF_BYTES);
  if (!sniffMatches(row.mime_type, start)) {
    await reject(row, "The file content does not match its type");
    throw badRequest("The file content does not match its type", "FILE_TYPE_MISMATCH");
  }
  await withEffects(async (fx) => {
    const updated = await fileRepo.transition(row.id, ["PENDING"], { status: "PROCESSING", size_bytes: head.sizeBytes, completed_at: new Date() });
    if (updated) fx.job("files.process", { fileId: row.id });
    return updated;
  });
  // Inline jobs (tests, tiny installs) may have made it READY already.
  return toFile((await fileRepo.findById(row.id)) ?? row);
}

export async function getFile(actor: Actor, id: string): Promise<ChatFile> {
  return toFile(await ownFile(actor, id));
}

export async function listFiles(actor: Actor, purpose: FilePurpose | undefined, limit = 50): Promise<ChatFile[]> {
  let q = db.selectFrom("files").selectAll().where("owner_id", "=", actor.id).where("status", "in", ["PROCESSING", "READY"]);
  if (purpose) q = q.where("purpose", "=", purpose);
  const rows = await q.orderBy("created_at", "desc").orderBy("id", "desc").limit(Math.min(limit, 200)).execute();
  return Promise.all(rows.map(toFile));
}

/**
 * Delete a file. Files sent in a message stay with that message (the conversation would
 * otherwise change under the reader): delete the conversation instead. Project files are
 * removed from their project first.
 */
export async function deleteFile(actor: Actor, id: string): Promise<void> {
  requireActive(actor);
  const row = await ownFile(actor, id);
  const inMessage = await db.selectFrom("message_files").select("file_id").where("file_id", "=", id).executeTakeFirst();
  if (inMessage) throw conflict("This file is part of a conversation; delete the conversation to remove it", "FILE_IN_USE");
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("project_files").where("file_id", "=", id).execute();
    await trx.updateTable("users").set({ avatar_file_id: null }).where("avatar_file_id", "=", id).execute();
    await trx.updateTable("files").set({ status: "DELETED", extracted_text: null }).where("id", "=", row.id).execute();
    await trx.deleteFrom("file_chunks").where("file_id", "=", id).execute();
  });
}

/** Resolve the AVATAR file an account points at (null clears it). */
export async function claimAvatar(actor: Actor, fileId: string | null): Promise<string | null> {
  if (fileId === null) return null;
  const row = await ownFile(actor, fileId);
  if (row.purpose !== "AVATAR") throw badRequest("Upload the picture as an avatar", "FILE_PURPOSE_MISMATCH");
  if (row.status !== "READY") throw conflict("The picture is still being processed", "FILE_NOT_READY");
  return row.id;
}

/**
 * Files a message may carry: the actor's own ATTACHMENT (or PROJECT) files, READY.
 * Throws on anything else, naming nothing about files that are not theirs.
 */
export async function attachableFiles(actor: Actor, ids: readonly string[], exec: Executor = db): Promise<FileRow[]> {
  if (!ids.length) return [];
  const rows = await fileRepo.findOwned(actor.id, ids, exec);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: FileRow[] = [];
  for (const id of new Set(ids)) {
    const r = byId.get(id);
    if (!r || r.status === "DELETED" || (r.purpose !== "ATTACHMENT" && r.purpose !== "PROJECT")) throw badRequest("One of the attached files was not found", "FILE_NOT_FOUND");
    if (r.status === "PROCESSING" || r.status === "PENDING") throw conflict(`"${r.file_name}" is still being processed`, "FILE_NOT_READY");
    if (r.status === "REJECTED") throw badRequest(`"${r.file_name}" could not be read`, "FILE_REJECTED");
    out.push(r);
  }
  return out;
}

/** Store bytes the server produced (a generated image) as a READY file of the user's. */
export async function storeGenerated(ownerId: string, data: Buffer, mimeType: string, fileName: string, exec: Executor = db): Promise<FileRow> {
  const id = newId();
  const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
  const key = storageKeyFor("GENERATED", id, ext);
  const store = storage();
  const meta = await sharp(data).metadata();
  await store.put(key, data, mimeType);
  const thumbKey = `${key}.thumb.webp`;
  await store.put(thumbKey, await sharp(data).resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(), "image/webp");
  return fileRepo.insert(
    {
      id,
      owner_id: ownerId,
      purpose: "GENERATED",
      kind: "IMAGE",
      mime_type: mimeType,
      file_name: fileName,
      declared_size: data.length,
      size_bytes: data.length,
      storage_key: key,
      thumb_key: thumbKey,
      width: meta.width ?? null,
      height: meta.height ?? null,
      status: "READY",
      completed_at: new Date(),
    },
    exec,
  );
}

/** Image bytes as base64, for vision models and image edits. */
export async function readImageBase64(row: FileRow): Promise<{ data: string; mimeType: string }> {
  return { data: (await storage().get(row.storage_key)).toString("base64"), mimeType: row.mime_type };
}

// ─── Processing job ─────────────────────────────────────────────────────────

/** files.process: make an uploaded file READY (see the header). */
export async function processFile(fileId: string): Promise<void> {
  const row = await fileRepo.findById(fileId);
  if (!row || row.status !== "PROCESSING") return;
  const store = storage();
  const original = await store.get(row.storage_key);

  if (row.kind === "IMAGE") {
    let processed: { data: Buffer; width: number; height: number; mime: string };
    try {
      processed = await reencodeImage(original, row.mime_type);
    } catch (err) {
      if (row.mime_type === "image/heic" || row.mime_type === "image/heif") {
        logger.warn({ fileId }, "HEIC image could not be decoded; rejected");
        await reject(row, HEIC_UNSUPPORTED);
        return;
      }
      captureError(err, { where: "files.process.image", fileId });
      await reject(row, "The image could not be read");
      return;
    }
    await store.put(row.storage_key, processed.data, processed.mime);
    const thumbKey = `${row.storage_key}.thumb.webp`;
    await store.put(thumbKey, await sharp(processed.data).resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(), "image/webp");
    await fileRepo.transition(row.id, ["PROCESSING"], {
      status: "READY",
      mime_type: processed.mime,
      width: processed.width,
      height: processed.height,
      size_bytes: processed.data.length,
      thumb_key: thumbKey,
    });
    return;
  }

  let text: string;
  let pageCount: number | null;
  try {
    const out = await extractTextFrom(row.kind, row.mime_type, original);
    text = cleanExtracted(out.text);
    pageCount = out.pageCount;
  } catch (err) {
    captureError(err, { where: "files.process.extract", fileId });
    await reject(row, "The document could not be read (it may be encrypted or damaged)");
    return;
  }
  if (!text) {
    await reject(row, row.kind === "PDF" ? "No text found: scanned PDFs need to be sent as images" : "The document has no text");
    return;
  }
  const capped = capText(text, MAX_EXTRACTED_CHARS).text;
  const chunks = chunkText(capped);
  await fileRepo.replaceChunks(row.id, chunks, chunks.map(() => newId()));
  await fileRepo.transition(row.id, ["PROCESSING"], { status: "READY", extracted_text: capped, token_estimate: estimateTokens(capped), page_count: pageCount });
}

async function reencodeImage(input: Buffer, mime: string): Promise<{ data: Buffer; width: number; height: number; mime: string }> {
  const animated = mime === "image/gif";
  let pipeline = sharp(input, { animated, failOn: "error" }).rotate().resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: "inside", withoutEnlargement: true });
  // HEIC becomes JPEG: providers and browsers read JPEG everywhere.
  let out = mime;
  if (mime === "image/png") pipeline = pipeline.png();
  else if (mime === "image/webp") pipeline = pipeline.webp({ quality: 88 });
  else if (mime === "image/gif") pipeline = pipeline.gif();
  else {
    pipeline = pipeline.jpeg({ quality: 88, mozjpeg: true });
    out = "image/jpeg";
  }
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.pageHeight ?? info.height, mime: out };
}

/** maintenance.expire-files: abandoned, rejected, deleted and never-used files. */
export async function expireFiles(batch = 500): Promise<number> {
  const store = storage();
  let total = 0;
  for (let round = 0; round < 20; round++) {
    const rows = await fileRepo.findExpired(batch);
    if (!rows.length) break;
    const deleted = new Set(await fileRepo.deleteUnreferenced(rows.map((r) => r.id)));
    for (const r of rows) {
      if (!deleted.has(r.id)) continue;
      for (const key of [r.storage_key, r.thumb_key]) {
        if (key) await store.delete(key).catch((err) => captureError(err, { where: "files.expire", fileId: r.id }));
      }
    }
    total += deleted.size;
    if (rows.length < batch) break;
  }
  return total;
}
