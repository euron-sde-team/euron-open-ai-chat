"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TierInput } from "@open-chat/api-client";
import { Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Field, IconButton, Input, Switch, toast } from "@open-chat/ui";
import { MoreHorizontal } from "lucide-react";
import type { QuotaTier } from "@open-chat/types";
import { api } from "@/lib/api";
import { adminErrorMessage, formatCount, limitLabel, limitText, parseLimit } from "@/lib/admin";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { AdminPage, DataTable, Dot, type Column } from "../shell";
import { adminMutation, ak } from "./common";

export function AdminQuotas() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ak.tiers, queryFn: () => api().admin.tiers() });
  const [editing, setEditing] = useState<QuotaTier | "new" | null>(null);
  const [deleting, setDeleting] = useState<QuotaTier | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api().admin.deleteTier(id),
    ...adminMutation(),
    onSuccess: (list) => {
      qc.setQueryData(ak.tiers, list);
      void qc.invalidateQueries({ queryKey: ak.usersPrefix });
      toast.success({ title: "Tier deleted" });
    },
  });
  const columns = useMemo<Column<QuotaTier>[]>(
    () => [
      {
        key: "name",
        header: "Tier",
        cell: (t) => (
          <span className="inline-flex items-center gap-2">
            <span className="font-medium text-foreground">{t.name}</span>
            {t.isDefault ? (
              <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <Dot tone="primary" /> Default
              </span>
            ) : null}
          </span>
        ),
        sortValue: (t) => t.name,
      },
      { key: "tokens", header: "Daily tokens", align: "right", cell: (t) => limitLabel(t.dailyTokens), sortValue: (t) => t.dailyTokens ?? Number.MAX_SAFE_INTEGER },
      { key: "images", header: "Daily images", align: "right", cell: (t) => limitLabel(t.dailyImages), sortValue: (t) => t.dailyImages ?? Number.MAX_SAFE_INTEGER, hideBelow: "sm" },
      { key: "file", header: "Max file", align: "right", cell: (t) => `${t.maxFileMb} MB`, sortValue: (t) => t.maxFileMb, hideBelow: "md" },
      { key: "users", header: "Users", align: "right", cell: (t) => formatCount(t.userCount), sortValue: (t) => t.userCount, hideBelow: "sm" },
      {
        key: "menu",
        header: <span className="sr-only">Actions</span>,
        align: "right",
        className: "w-10",
        cell: (t) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`Actions for ${t.name}`} size="sm" data-testid={`tier-menu-${t.name}`}>
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEditing(t)}>Edit</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setDeleting(t)} disabled={t.isDefault} className="text-danger">
                {t.isDefault ? "Default tier cannot be deleted" : "Delete"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [],
  );
  return (
    <AdminPage
      title="Quotas"
      description="Daily allowances per tier, counted in UTC days. Tokens are weighted by each model's weight. Every account is on the default tier unless you move it."
      actions={
        <Button onClick={() => setEditing("new")} data-testid="tier-add">
          Add tier
        </Button>
      }
      testId="admin-quotas"
    >
      <DataTable
        caption="Quota tiers"
        rows={q.data ?? []}
        columns={columns}
        rowKey={(t) => t.id}
        onRowClick={(t) => setEditing(t)}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        skeletonRows={3}
        empty={{ title: "No tiers yet." }}
        rowTestId={(t) => `tier-row-${t.name}`}
        testId="tiers-table"
      />
      <p className="mt-4 text-[13px] text-muted-foreground">To give one account its own limits, open it on the Users page.</p>
      <TierDialog value={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete the ${deleting?.name ?? ""} tier?`}
        description={deleting?.userCount ? `Its ${formatCount(deleting.userCount)} ${deleting.userCount === 1 ? "account moves" : "accounts move"} to the default tier.` : "No accounts use it."}
        confirmLabel="Delete tier"
        destructive
        onConfirm={() => del.mutateAsync(deleting!.id)}
      />
    </AdminPage>
  );
}

/** Field errors for a tier draft, matching the API's limits. */
export function tierDraftErrors(d: { name: string; tokens: string; images: string; maxFileMb: string }): Partial<Record<"name" | "tokens" | "images" | "maxFileMb", string>> {
  const e: Partial<Record<"name" | "tokens" | "images" | "maxFileMb", string>> = {};
  if (!d.name.trim()) e.name = "Give the tier a name.";
  else if (d.name.trim().length > 60) e.name = "Use 60 characters or fewer.";
  if (parseLimit(d.tokens) === undefined) e.tokens = "Use a whole number, or leave it empty for unlimited.";
  if (parseLimit(d.images) === undefined) e.images = "Use a whole number, or leave it empty for unlimited.";
  const mb = Number(d.maxFileMb);
  if (!/^\d+$/.test(d.maxFileMb.trim()) || mb < 1 || mb > 500) e.maxFileMb = "Between 1 and 500 MB.";
  return e;
}

function TierDialog({ value, onClose }: { value: QuotaTier | "new" | null; onClose: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const existing = value && value !== "new" ? value : null;
  const [d, setD] = useState({ name: "", tokens: "", images: "", maxFileMb: "25", isDefault: false });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return;
    setError(null);
    setD(existing ? { name: existing.name, tokens: limitText(existing.dailyTokens), images: limitText(existing.dailyImages), maxFileMb: String(existing.maxFileMb), isDefault: existing.isDefault } : { name: "", tokens: "", images: "", maxFileMb: "25", isDefault: false });
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const errs = tierDraftErrors(d);
  const ok = Object.keys(errs).length === 0;
  const save = useMutation({
    mutationFn: () => {
      const body: TierInput = { name: d.name.trim(), dailyTokens: parseLimit(d.tokens) ?? null, dailyImages: parseLimit(d.images) ?? null, maxFileMb: Number(d.maxFileMb), isDefault: d.isDefault };
      return existing ? api().admin.updateTier(existing.id, body) : api().admin.createTier(body);
    },
    ...adminMutation({ inline: true }),
    onError: (e) => setError(adminErrorMessage(e)),
    onSuccess: (list) => {
      qc.setQueryData(ak.tiers, list);
      void qc.invalidateQueries({ queryKey: ak.usersPrefix });
      toast.success({ title: existing ? "Tier saved" : "Tier added" });
      onClose();
    },
  });
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="md" data-testid="tier-dialog">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{existing ? `Edit ${existing.name}` : "Add a tier"}</DialogTitle>
            <DialogDescription>Leave a limit empty for unlimited.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field label="Name" htmlFor={`${id}-name`} error={d.name ? errs.name : undefined}>
              <Input id={`${id}-name`} value={d.name} maxLength={60} onChange={(e) => setD((x) => ({ ...x, name: e.target.value }))} data-testid="tier-name" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Daily weighted tokens" htmlFor={`${id}-t`} error={errs.tokens}>
                <Input id={`${id}-t`} inputMode="numeric" placeholder="Unlimited" value={d.tokens} onChange={(e) => setD((x) => ({ ...x, tokens: e.target.value }))} data-testid="tier-tokens" />
              </Field>
              <Field label="Daily images" htmlFor={`${id}-i`} error={errs.images}>
                <Input id={`${id}-i`} inputMode="numeric" placeholder="Unlimited" value={d.images} onChange={(e) => setD((x) => ({ ...x, images: e.target.value }))} data-testid="tier-images" />
              </Field>
            </div>
            <Field label="Largest file, in MB" htmlFor={`${id}-mb`} error={errs.maxFileMb}>
              <Input id={`${id}-mb`} inputMode="numeric" value={d.maxFileMb} onChange={(e) => setD((x) => ({ ...x, maxFileMb: e.target.value }))} className="w-32" data-testid="tier-max-file" />
            </Field>
            <label className="flex items-center justify-between gap-4 border-t border-border pt-4 text-[14px]">
              <span>
                <span className="font-medium">Default tier</span>
                <span className="block text-[13px] text-muted-foreground">
                  {existing?.isDefault ? "To change the default, make another tier the default." : "New accounts and accounts without a tier use it. There is always exactly one default."}
                </span>
              </span>
              <Switch checked={d.isDefault} onCheckedChange={(v) => setD((x) => ({ ...x, isDefault: v }))} disabled={!!existing?.isDefault} data-testid="tier-default" />
            </label>
            {error ? (
              <p role="alert" className="text-[13px] font-medium text-danger">
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ok} loading={save.isPending} data-testid="tier-save">
              {existing ? "Save" : "Add tier"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
