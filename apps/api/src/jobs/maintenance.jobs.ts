/**
 * Job handlers of the operations module (schedules in worker.ts):
 *
 *   files.process                  re-encode an image or read a document (services/file.service.ts)
 *   maintenance.expire-files       abandoned, rejected, deleted and never-used files
 *   maintenance.lift-suspensions   timed suspensions that have run out
 *   maintenance.purge-accounts     erase accounts whose deletion grace period is over
 *   maintenance.sweep-turns        turns left STREAMING by a crashed task become FAILED
 *   maintenance.retention          conversations past the retention setting are deleted
 *
 * Every step is safe to run twice or on two workers at once: state changes are
 * conditional UPDATEs, and the purge re-checks each account under a row lock.
 */
import { sql } from "kysely";
import { withTransaction } from "../core/effects";
import { captureError, logger } from "../core/logger";
import { db } from "../db/kysely";
import { anonymiseUser, DELETION_GRACE_DAYS } from "../services/account.service";
import { audit } from "../services/audit.service";
import { expireFiles, processFile } from "../services/file.service";
import { getSettings } from "../services/settings.service";
import { registerJob } from "./registry";

/** SUSPENDED accounts whose suspended_until has passed become ACTIVE. Returns how many. */
export async function liftSuspensions(): Promise<number> {
  const rows = await db
    .updateTable("users")
    .set({ status: "ACTIVE", suspended_until: null, updated_at: new Date() })
    .where("status", "=", "SUSPENDED")
    .where("suspended_until", "<=", new Date())
    .returning("id")
    .execute();
  for (const r of rows) await audit({ actorId: null, action: "user.suspension_lifted", entityType: "user", entityId: r.id });
  return rows.length;
}

/** Erase accounts whose deletion request is older than the grace period. Returns how many. */
export async function purgeAccounts(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DELETION_GRACE_DAYS * 86_400_000);
  const due = await db.selectFrom("users").select("id").where("deletion_requested_at", "<=", cutoff).limit(200).execute();
  let n = 0;
  for (const { id } of due) {
    try {
      const done = await withTransaction(async (trx) => {
        // Re-check under a row lock: they may have signed in (cancelling it) since the select.
        const row = await trx.selectFrom("users").select("deletion_requested_at").where("id", "=", id).forUpdate().executeTakeFirst();
        if (!row?.deletion_requested_at || row.deletion_requested_at > cutoff) return false;
        await anonymiseUser(id, trx);
        await audit({ actorId: null, action: "user.purged", entityType: "user", entityId: id }, trx);
        return true;
      });
      if (done) n++;
    } catch (err) {
      captureError(err, { where: "maintenance.purge-accounts", userId: id });
    }
  }
  return n;
}

/**
 * A message still STREAMING long after it was created lost the task that ran its turn
 * (a crash or a deploy): no turn takes that long (provider calls time out after three
 * minutes and a turn makes at most four). Fail it so the client stops waiting and the
 * conversation can continue.
 */
export async function sweepTurns(maxAgeMinutes = 15): Promise<number> {
  const rows = await db
    .updateTable("messages")
    .set({ status: "FAILED", error_code: "INTERNAL", completed_at: new Date() })
    .where("status", "=", "STREAMING")
    .where("created_at", "<", sql<Date>`now() - make_interval(mins => ${maxAgeMinutes})`)
    .returning("id")
    .execute();
  if (rows.length) logger.warn({ count: rows.length }, "stale turns marked failed");
  return rows.length;
}

/** Delete conversations untouched for longer than settings.retentionDays (when set). */
export async function applyRetention(): Promise<number> {
  const { retentionDays } = await getSettings();
  if (!retentionDays) return 0;
  let total = 0;
  for (let round = 0; round < 50; round++) {
    const res = await sql<{ id: string }>`
      DELETE FROM conversations WHERE id IN (
        SELECT id FROM conversations WHERE last_message_at < now() - make_interval(days => ${retentionDays}) LIMIT 500
      ) RETURNING id`.execute(db);
    total += res.rows.length;
    if (res.rows.length < 500) break;
  }
  if (total) await audit({ actorId: null, action: "retention.applied", entityType: "settings", entityId: "app", data: { deleted: total, retentionDays } });
  return total;
}

export function registerMaintenanceJobs(): void {
  registerJob("files.process", async ({ fileId }) => processFile(fileId));
  registerJob("maintenance.expire-files", async () => {
    const n = await expireFiles();
    if (n) logger.info({ count: n }, "expired files deleted");
  });
  registerJob("maintenance.lift-suspensions", async () => void (await liftSuspensions()));
  registerJob("maintenance.purge-accounts", async () => void (await purgeAccounts()));
  registerJob("maintenance.sweep-turns", async () => void (await sweepTurns()));
  registerJob("maintenance.retention", async () => void (await applyRetention()));
}
