/**
 * Files. Besides plain CRUD this knows every table that can reference a file, so
 * "is it still used?" (delete, expiry) has one definition.
 */
import { sql, type Insertable, type Selectable, type Updateable } from "kysely";
import { db, type Executor } from "../db/kysely";
import type { Files } from "../db/types";

export type FileRow = Selectable<Files>;

/** Every column that can point at a file. */
const REFERENCES = sql`
  EXISTS (SELECT 1 FROM users r WHERE r.avatar_file_id = f.id)
  OR EXISTS (SELECT 1 FROM message_files r WHERE r.file_id = f.id)
  OR EXISTS (SELECT 1 FROM project_files r WHERE r.file_id = f.id)
  OR EXISTS (SELECT 1 FROM images r WHERE r.file_id = f.id)
  OR EXISTS (SELECT 1 FROM shares r WHERE f.id = ANY (r.file_ids) AND r.revoked_at IS NULL)`;

export class FileRepository {
  findById(id: string, exec: Executor = db) {
    return exec.selectFrom("files").selectAll().where("id", "=", id).executeTakeFirst();
  }

  findMany(ids: readonly string[], exec: Executor = db): Promise<FileRow[]> {
    if (!ids.length) return Promise.resolve([]);
    return exec.selectFrom("files").selectAll().where("id", "in", [...new Set(ids)]).execute();
  }

  /** The owner's files among `ids`, in any status. Ownership is part of the query, never checked after. */
  findOwned(ownerId: string, ids: readonly string[], exec: Executor = db): Promise<FileRow[]> {
    if (!ids.length) return Promise.resolve([]);
    return exec.selectFrom("files").selectAll().where("owner_id", "=", ownerId).where("id", "in", [...new Set(ids)]).execute();
  }

  insert(row: Insertable<Files>, exec: Executor = db) {
    return exec.insertInto("files").values(row).returningAll().executeTakeFirstOrThrow();
  }

  update(id: string, patch: Updateable<Files>, exec: Executor = db) {
    return exec.updateTable("files").set(patch).where("id", "=", id).returningAll().executeTakeFirst();
  }

  /** Move a row from one status to another only if it is still in the expected one (job retries). */
  transition(id: string, from: FileRow["status"][], patch: Updateable<Files>, exec: Executor = db) {
    return exec.updateTable("files").set(patch).where("id", "=", id).where("status", "in", from).returningAll().executeTakeFirst();
  }

  async isReferenced(id: string, exec: Executor = db): Promise<boolean> {
    const row = await sql<{ used: boolean }>`SELECT (${REFERENCES}) AS used FROM files f WHERE f.id = ${id}`.execute(exec);
    return !!row.rows[0]?.used;
  }

  replaceChunks(fileId: string, chunks: string[], ids: string[], exec: Executor = db) {
    return exec.transaction().execute(async (trx) => {
      await trx.deleteFrom("file_chunks").where("file_id", "=", fileId).execute();
      if (chunks.length) await trx.insertInto("file_chunks").values(chunks.map((content, ordinal) => ({ id: ids[ordinal]!, file_id: fileId, ordinal, content }))).execute();
    });
  }

  /**
   * Files the expiry job may delete: PENDING older than 24h, REJECTED and DELETED rows,
   * and READY uploads that nothing references 48h after they were created (an attachment
   * picked and never sent).
   */
  async findExpired(limit: number, exec: Executor = db): Promise<Pick<FileRow, "id" | "storage_key" | "thumb_key">[]> {
    const res = await sql<Pick<FileRow, "id" | "storage_key" | "thumb_key">>`
      SELECT f.id, f.storage_key, f.thumb_key FROM files f
      WHERE (f.status IN ('PENDING', 'PROCESSING') AND f.created_at < now() - interval '24 hours')
         OR f.status IN ('REJECTED', 'DELETED')
         OR (f.status = 'READY' AND f.created_at < now() - interval '48 hours' AND NOT (${REFERENCES}))
      ORDER BY f.created_at
      LIMIT ${limit}`.execute(exec);
    return res.rows;
  }

  /** Delete rows, re-checking that nothing references them since they were selected (DELETED rows always go). */
  async deleteUnreferenced(ids: string[], exec: Executor = db): Promise<string[]> {
    if (!ids.length) return [];
    const res = await sql<{ id: string }>`
      DELETE FROM files f WHERE f.id = ANY(${ids}::text[]) AND (f.status IN ('PENDING', 'PROCESSING', 'REJECTED', 'DELETED') OR NOT (${REFERENCES}))
      RETURNING f.id`.execute(exec);
    return res.rows.map((r) => r.id);
  }
}

export const fileRepo = new FileRepository();
