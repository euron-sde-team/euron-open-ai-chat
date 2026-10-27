/**
 * File rows to DTOs. URLs are signed per response and expire; clients refetch the parent
 * resource rather than caching URLs.
 *
 * Presenters batch: collect every file id a response needs, call `loadFiles` once, then
 * look each id up in the returned map.
 */
import type { ChatFile } from "@open-chat/types";
import { type Executor, db } from "../db/kysely";
import { storage } from "../integrations/storage";
import { fileRepo, type FileRow } from "../repositories/file.repository";

/** Images are shown to their owner only once READY: until processed, the stored bytes still carry EXIF (GPS, camera serial). */
export function isPresentable(row: Pick<FileRow, "status">): boolean {
  return row.status === "READY";
}

export async function toFile(row: FileRow): Promise<ChatFile> {
  const store = storage();
  const ready = isPresentable(row);
  const inline = row.kind === "IMAGE";
  return {
    id: row.id,
    purpose: row.purpose,
    kind: row.kind,
    mimeType: row.mime_type,
    fileName: row.file_name,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    width: row.width,
    height: row.height,
    pageCount: row.page_count,
    status: row.status,
    rejectedReason: row.status === "REJECTED" ? row.rejected_reason : null,
    url: ready ? await store.signedGetUrl(row.storage_key, inline ? {} : { downloadName: row.file_name }) : null,
    thumbUrl: ready && row.thumb_key ? await store.signedGetUrl(row.thumb_key) : null,
    createdAt: row.created_at.toISOString(),
  };
}

/** Load and sign files by id. Deleted ones are omitted. */
export async function loadFiles(ids: readonly (string | null | undefined)[], exec: Executor = db): Promise<Map<string, ChatFile>> {
  const wanted = ids.filter((x): x is string => !!x);
  const rows = (await fileRepo.findMany(wanted, exec)).filter((r) => r.status !== "DELETED");
  const out = new Map<string, ChatFile>();
  await Promise.all(rows.map(async (row) => out.set(row.id, await toFile(row))));
  return out;
}

/** Avatar thumbnails by file id (only READY avatars). */
export async function avatarUrls(ids: readonly (string | null | undefined)[], exec: Executor = db): Promise<Map<string, string>> {
  const files = await loadFiles(ids, exec);
  const out = new Map<string, string>();
  for (const [id, f] of files) if (f.purpose === "AVATAR" && (f.thumbUrl ?? f.url)) out.set(id, (f.thumbUrl ?? f.url)!);
  return out;
}
