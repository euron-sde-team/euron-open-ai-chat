import type { Me, UserSummary } from "@open-chat/types";
import { type Executor, db } from "../db/kysely";
import { userRepo, type SummaryRow, type UserRow } from "../repositories/user.repository";
import { avatarUrls } from "./file.presenter";

export type { SummaryRow };

export function toSummary(row: SummaryRow, avatarUrl: string | null): UserSummary {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl,
    role: row.role,
  };
}

/** Batch-load UserSummary DTOs for a set of user ids. */
export async function loadSummaries(ids: readonly (string | null | undefined)[], exec: Executor = db): Promise<Map<string, UserSummary>> {
  const wanted = ids.filter((x): x is string => !!x);
  const rows = await userRepo.findSummaries(wanted, exec);
  const urls = await avatarUrls(rows.map((r) => r.avatar_file_id), exec);
  return new Map(rows.map((r) => [r.id, toSummary(r, r.avatar_file_id ? (urls.get(r.avatar_file_id) ?? null) : null)]));
}

export async function summaryOf(id: string, exec: Executor = db): Promise<UserSummary | null> {
  return (await loadSummaries([id], exec)).get(id) ?? null;
}

export async function toMe(row: UserRow, exec: Executor = db): Promise<Me> {
  const summary = await summaryOf(row.id, exec);
  return {
    ...(summary as UserSummary),
    email: row.email,
    status: row.status,
    suspendedUntil: row.status === "SUSPENDED" && row.suspended_until ? row.suspended_until.toISOString() : null,
    emailVerified: !!row.email_verified_at,
    totpEnabled: row.totp_enabled,
    deletionRequestedAt: row.deletion_requested_at?.toISOString() ?? null,
    canOpenAdmin: row.role === "ADMIN",
  };
}
