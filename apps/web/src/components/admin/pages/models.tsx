"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModelInput } from "@open-chat/api-client";
import {
  Button, Checkbox, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger, Field, IconButton, Input, Select, Switch, Textarea, toast,
} from "@open-chat/ui";
import { MoreHorizontal } from "lucide-react";
import type { AdminModel, AdminProvider, ModelKind, ModelTestResult, ProviderKind } from "@open-chat/types";
import { api } from "@/lib/api";
import { MODEL_KINDS, PROVIDER_KIND_LABEL, SLUG_RE, adminErrorMessage, groupModels, tokensShort } from "@/lib/admin";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorState } from "@/components/common/states";
import { AdminPage, AdminSection, DataTable, StatusText, type Column } from "../shell";
import { adminMutation, ak } from "./common";

export function AdminModels() {
  const [providerDialog, setProviderDialog] = useState<AdminProvider | "new" | null>(null);
  const [modelDialog, setModelDialog] = useState<AdminModel | { kind: ModelKind } | null>(null);
  return (
    <AdminPage
      title="Models"
      description="The providers this server talks to and the models people can pick in chat."
      actions={
        <Button onClick={() => setModelDialog({ kind: "CHAT" })} data-testid="model-add">
          Add model
        </Button>
      }
      testId="admin-models"
    >
      <Providers onEdit={setProviderDialog} />
      <Models onEdit={setModelDialog} />
      <ProviderDialog value={providerDialog} onClose={() => setProviderDialog(null)} />
      <ModelDialog value={modelDialog} onClose={() => setModelDialog(null)} />
    </AdminPage>
  );
}

// ─── Providers ──────────────────────────────────────────────────────────────

function Providers({ onEdit }: { onEdit: (p: AdminProvider | "new") => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ak.providers, queryFn: () => api().admin.providers() });
  const [deleting, setDeleting] = useState<AdminProvider | null>(null);
  const columns = useMemo<Column<AdminProvider>[]>(
    () => [
      {
        key: "name",
        header: "Provider",
        cell: (p) => (
          <div className="min-w-0">
            <p className="font-medium text-foreground">{p.displayName}</p>
            <p className="truncate font-mono text-[12px] text-muted-foreground">{p.id}</p>
          </div>
        ),
      },
      { key: "kind", header: "Kind", cell: (p) => <span className="text-muted-foreground">{PROVIDER_KIND_LABEL[p.kind]}</span>, hideBelow: "sm" },
      { key: "url", header: "Base URL", cell: (p) => <span className="break-all font-mono text-[12px] text-muted-foreground">{p.baseUrl ?? "Default"}</span>, hideBelow: "lg" },
      {
        key: "key",
        header: "Key configured",
        cell: (p) => (p.keyConfigured ? <StatusText tone="success">Yes</StatusText> : <StatusText tone="warning">No</StatusText>),
      },
      { key: "enabled", header: "Enabled", cell: (p) => (p.enabled ? <span className="text-foreground">On</span> : <span className="text-muted-foreground">Off</span>), hideBelow: "sm" },
      { key: "models", header: "Models", align: "right", cell: (p) => p.modelCount, hideBelow: "md" },
      {
        key: "menu",
        header: <span className="sr-only">Actions</span>,
        align: "right",
        className: "w-10",
        cell: (p) => (
          <RowMenu label={`Actions for ${p.displayName}`} onEdit={() => onEdit(p)} onDelete={() => setDeleting(p)} testId={`provider-menu-${p.id}`} />
        ),
      },
    ],
    [onEdit],
  );
  const del = useMutation({
    mutationFn: (id: string) => api().admin.deleteProvider(id),
    ...adminMutation(),
    onSuccess: (list) => {
      qc.setQueryData(ak.providers, list);
      void qc.invalidateQueries({ queryKey: ak.models });
      toast.success({ title: "Provider deleted" });
    },
  });
  return (
    <AdminSection
      title="Providers"
      id="providers"
      description="API keys live in the server's PROVIDER_KEYS secret, keyed by the provider slug. They are never shown or stored here."
      actions={
        <Button variant="outline" size="sm" onClick={() => onEdit("new")} data-testid="provider-add">
          Add provider
        </Button>
      }
    >
      <DataTable caption="Providers" rows={q.data ?? []} columns={columns} rowKey={(p) => p.id} onRowClick={(p) => onEdit(p)} loading={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeletonRows={3} empty={{ title: "No providers yet. Add one to start adding models." }} testId="providers-table" />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.displayName ?? "provider"}?`}
        description={deleting?.modelCount ? `Its ${deleting.modelCount} ${deleting.modelCount === 1 ? "model is" : "models are"} deleted too, with their usage history. To hide it instead, turn it off.` : "It has no models."}
        confirmLabel="Delete provider"
        destructive
        onConfirm={() => del.mutateAsync(deleting!.id)}
      />
    </AdminSection>
  );
}

function RowMenu({ label, onEdit, onDelete, onTest, testId }: { label: string; onEdit: () => void; onDelete: () => void; onTest?: () => void; testId?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={label} size="sm" data-testid={testId}>
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>
        {onTest ? <DropdownMenuItem onSelect={onTest}>Test</DropdownMenuItem> : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onDelete} className="text-danger">
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const PROVIDER_KINDS = Object.keys(PROVIDER_KIND_LABEL) as ProviderKind[];

function ProviderDialog({ value, onClose }: { value: AdminProvider | "new" | null; onClose: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const isNew = value === "new";
  const existing = value && value !== "new" ? value : null;
  const blank = { id: "", kind: "OPENAI" as ProviderKind, displayName: "", baseUrl: "", enabled: true };
  const [f, setF] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return;
    setError(null);
    setF(existing ? { id: existing.id, kind: existing.kind, displayName: existing.displayName, baseUrl: existing.baseUrl ?? "", enabled: existing.enabled } : blank);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const slugOk = !isNew || SLUG_RE.test(f.id);
  const urlOk = !f.baseUrl.trim() || /^https?:\/\/\S+$/i.test(f.baseUrl.trim());
  const urlNeeded = f.kind === "OPENAI_COMPATIBLE" && !f.baseUrl.trim();
  const ok = slugOk && urlOk && !urlNeeded && f.displayName.trim().length > 0;
  const save = useMutation({
    mutationFn: () => {
      const body = { kind: f.kind, displayName: f.displayName.trim(), baseUrl: f.baseUrl.trim() || null, enabled: f.enabled };
      return isNew ? api().admin.createProvider({ id: f.id, ...body }) : api().admin.updateProvider(existing!.id, body);
    },
    ...adminMutation({ inline: true }),
    onError: (e) => setError(adminErrorMessage(e)),
    onSuccess: (list) => {
      qc.setQueryData(ak.providers, list);
      toast.success({ title: isNew ? "Provider added" : "Provider saved" });
      onClose();
    },
  });
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="md" data-testid="provider-dialog">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{isNew ? "Add a provider" : `Edit ${existing?.displayName ?? "provider"}`}</DialogTitle>
            <DialogDescription>The key goes in the server&apos;s PROVIDER_KEYS secret under this slug, then restart the API.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field label="Slug" htmlFor={`${id}-slug`} hint={isNew ? "Lowercase letters, digits and hyphens. It cannot change later." : "The slug cannot change."} error={!slugOk && f.id ? "Use 3 to 40 lowercase letters, digits and hyphens." : undefined}>
              <Input id={`${id}-slug`} value={f.id} onChange={(e) => setF((x) => ({ ...x, id: e.target.value.toLowerCase() }))} disabled={!isNew} autoComplete="off" className="font-mono" data-testid="provider-slug" />
            </Field>
            <Field label="Kind" htmlFor={`${id}-kind`}>
              <Select id={`${id}-kind`} value={f.kind} onValueChange={(v) => setF((x) => ({ ...x, kind: v as ProviderKind }))} options={PROVIDER_KINDS.map((k) => ({ value: k, label: PROVIDER_KIND_LABEL[k] }))} data-testid="provider-kind" />
            </Field>
            <Field label="Display name" htmlFor={`${id}-name`}>
              <Input id={`${id}-name`} value={f.displayName} maxLength={60} onChange={(e) => setF((x) => ({ ...x, displayName: e.target.value }))} data-testid="provider-name" />
            </Field>
            <Field
              label="Base URL"
              htmlFor={`${id}-url`}
              optional={f.kind !== "OPENAI_COMPATIBLE"}
              hint={f.kind === "OPENAI_COMPATIBLE" ? "Required: the server's OpenAI-style endpoint, such as http://localhost:11434/v1." : "Leave empty to use the provider's own endpoint."}
              error={!urlOk ? "Use an http or https URL." : undefined}
            >
              <Input id={`${id}-url`} value={f.baseUrl} maxLength={300} onChange={(e) => setF((x) => ({ ...x, baseUrl: e.target.value }))} className="font-mono" data-testid="provider-url" />
            </Field>
            <label className="flex items-center justify-between gap-4 text-[14px]">
              <span>
                <span className="font-medium">Enabled</span>
                <span className="block text-[13px] text-muted-foreground">Turned off, its models are hidden from chat.</span>
              </span>
              <Switch checked={f.enabled} onCheckedChange={(v) => setF((x) => ({ ...x, enabled: v }))} data-testid="provider-enabled" />
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
            <Button type="submit" disabled={!ok} loading={save.isPending} data-testid="provider-save">
              {isNew ? "Add provider" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Models ─────────────────────────────────────────────────────────────────

function Models({ onEdit }: { onEdit: (m: AdminModel | { kind: ModelKind }) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ak.models, queryFn: () => api().admin.models() });
  const providers = useQuery({ queryKey: ak.providers, queryFn: () => api().admin.providers() });
  const [deleting, setDeleting] = useState<AdminModel | null>(null);
  const [testing, setTesting] = useState<AdminModel | null>(null);
  const groups = useMemo(() => groupModels(q.data ?? []), [q.data]);
  const providerName = (id: string) => providers.data?.find((p) => p.id === id)?.displayName ?? id;
  const del = useMutation({
    mutationFn: (id: string) => api().admin.deleteModel(id),
    ...adminMutation(),
    onSuccess: (list) => {
      qc.setQueryData(ak.models, list);
      void qc.invalidateQueries({ queryKey: ak.providers });
      toast.success({ title: "Model deleted" });
    },
  });
  const columns: Column<AdminModel>[] = [
    {
      key: "name",
      header: "Model",
      cell: (m) => (
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            {m.displayName}
            {m.isDefault ? <span className="ml-2 text-[12.5px] font-normal text-muted-foreground">Default</span> : null}
          </p>
          <p className="truncate font-mono text-[12px] text-muted-foreground">{m.modelRef}</p>
        </div>
      ),
    },
    { key: "provider", header: "Provider", cell: (m) => <span className="text-muted-foreground">{providerName(m.providerId)}</span>, hideBelow: "sm" },
    { key: "ctx", header: "Context", align: "right", cell: (m) => <span className="text-muted-foreground">{tokensShort(m.contextWindow)}</span>, hideBelow: "lg" },
    { key: "weight", header: "Weight", align: "right", cell: (m) => `${m.weight}x`, hideBelow: "md" },
    { key: "enabled", header: "Enabled", cell: (m) => (m.enabled ? <span className="text-foreground">On</span> : <span className="text-muted-foreground">Off</span>), hideBelow: "sm" },
    {
      key: "menu",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      className: "w-10",
      cell: (m) => <RowMenu label={`Actions for ${m.displayName}`} onEdit={() => onEdit(m)} onTest={() => setTesting(m)} onDelete={() => setDeleting(m)} testId={`model-menu-${m.modelRef}`} />,
    },
  ];
  if (q.isError && !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <>
      {MODEL_KINDS.map((k) => (
        <AdminSection
          key={k.kind}
          id={`models-${k.kind.toLowerCase()}`}
          title={k.label}
          description={k.description}
          actions={
            <Button variant="ghost" size="sm" onClick={() => onEdit({ kind: k.kind })} data-testid={`model-add-${k.kind.toLowerCase()}`}>
              Add
            </Button>
          }
        >
          <DataTable caption={`${k.label} models`} rows={groups[k.kind]} columns={columns} rowKey={(m) => m.id} onRowClick={(m) => onEdit(m)} loading={q.isPending} skeletonRows={2} empty={{ title: `No ${k.label.toLowerCase()} models yet.` }} testId={`models-${k.kind.toLowerCase()}`} />
        </AdminSection>
      ))}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.displayName ?? "model"}?`}
        description="Its usage history is deleted with it, which lowers the totals on the overview. To hide it from chat instead, turn it off."
        confirmLabel="Delete model"
        destructive
        onConfirm={() => del.mutateAsync(deleting!.id)}
      />
      <TestDialog model={testing} onClose={() => setTesting(null)} />
    </>
  );
}

function TestDialog({ model, onClose }: { model: AdminModel | null; onClose: () => void }) {
  const test = useMutation<ModelTestResult, unknown, string>({ mutationFn: (id) => api().admin.testModel(id), meta: { silent: true } });
  const { mutate, reset } = test;
  useEffect(() => {
    if (model) mutate(model.id);
    else reset();
  }, [model, mutate, reset]);
  const r = test.data;
  return (
    <Dialog open={!!model} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm" data-testid="model-test-dialog">
        <DialogHeader>
          <DialogTitle>Test {model?.displayName}</DialogTitle>
          <DialogDescription>One tiny request through the provider, to check the key and the model id.</DialogDescription>
        </DialogHeader>
        <DialogBody aria-live="polite">
          {test.isPending ? (
            <p className="text-[14px] text-muted-foreground">Calling the provider...</p>
          ) : test.isError ? (
            <p role="alert" className="text-[14px] text-danger">
              {adminErrorMessage(test.error)}
            </p>
          ) : r ? (
            <div className="space-y-2" data-testid="model-test-result">
              <StatusText tone={r.ok ? "success" : "danger"} className="text-[15px] font-medium">
                {r.ok ? "Working" : "Failed"}
              </StatusText>
              <p className="text-[13.5px] text-muted-foreground">Answered in {r.latencyMs} ms.</p>
              <p className="break-words text-[14px] text-foreground">{r.message}</p>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => model && mutate(model.id)} disabled={test.isPending}>
            Run again
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ModelDraft = Omit<ModelInput, "contextWindow" | "maxOutputTokens" | "weight" | "sortOrder"> & { contextWindow: string; maxOutputTokens: string; weight: string; sortOrder: string };

const toDraft = (m: AdminModel | { kind: ModelKind }, providerId: string): ModelDraft =>
  "id" in m
    ? { ...m, contextWindow: String(m.contextWindow), maxOutputTokens: String(m.maxOutputTokens), weight: String(m.weight), sortOrder: String(m.sortOrder) }
    : {
        providerId,
        kind: m.kind,
        modelRef: "",
        displayName: "",
        description: "",
        supportsVision: false,
        supportsTools: false,
        supportsReasoning: false,
        contextWindow: "128000",
        maxOutputTokens: "4096",
        weight: "1",
        enabled: true,
        isDefault: false,
        sortOrder: "0",
      };

/** Field errors for a model draft, matching the API's limits. */
export function modelDraftErrors(d: ModelDraft): Partial<Record<keyof ModelDraft, string>> {
  const e: Partial<Record<keyof ModelDraft, string>> = {};
  const int = (s: string, min: number, max: number) => /^\d+$/.test(s.trim()) && Number(s) >= min && Number(s) <= max;
  if (!d.providerId) e.providerId = "Pick a provider.";
  if (!d.modelRef.trim()) e.modelRef = "Enter the provider's model id.";
  if (!d.displayName.trim()) e.displayName = "Give it a name people will see.";
  if (!int(d.contextWindow, 1024, 10_000_000)) e.contextWindow = "Between 1,024 and 10,000,000.";
  if (!int(d.maxOutputTokens, 16, 1_000_000)) e.maxOutputTokens = "Between 16 and 1,000,000.";
  const w = Number(d.weight);
  if (!d.weight.trim() || !Number.isFinite(w) || w < 0.01 || w > 1000) e.weight = "Between 0.01 and 1,000.";
  if (!int(d.sortOrder, 0, 10_000)) e.sortOrder = "Between 0 and 10,000.";
  return e;
}

function ModelDialog({ value, onClose }: { value: AdminModel | { kind: ModelKind } | null; onClose: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ak.providers, queryFn: () => api().admin.providers() });
  const existing = value && "id" in value ? value : null;
  const [d, setD] = useState<ModelDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return;
    setError(null);
    setD(toDraft(value, providers.data?.[0]?.id ?? ""));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const errs = d ? modelDraftErrors(d) : {};
  const ok = !!d && Object.keys(errs).length === 0;
  const save = useMutation({
    mutationFn: () => {
      const body: ModelInput = {
        ...d!,
        modelRef: d!.modelRef.trim(),
        displayName: d!.displayName.trim(),
        description: d!.description.trim(),
        contextWindow: Number(d!.contextWindow),
        maxOutputTokens: Number(d!.maxOutputTokens),
        weight: Number(d!.weight),
        sortOrder: Number(d!.sortOrder),
      };
      return existing ? api().admin.updateModel(existing.id, body) : api().admin.createModel(body);
    },
    ...adminMutation({ inline: true }),
    onError: (e) => setError(adminErrorMessage(e)),
    onSuccess: (list) => {
      qc.setQueryData(ak.models, list);
      void qc.invalidateQueries({ queryKey: ak.providers });
      toast.success({ title: existing ? "Model saved" : "Model added" });
      onClose();
    },
  });
  const set = <K extends keyof ModelDraft>(k: K, v: ModelDraft[K]) => setD((x) => (x ? { ...x, [k]: v } : x));
  const err = (k: keyof ModelDraft, touched: boolean) => (touched ? errs[k] : undefined);
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="lg" data-testid="model-dialog">
        {d ? (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              if (ok) save.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>{existing ? `Edit ${existing.displayName}` : "Add a model"}</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Provider" htmlFor={`${id}-p`} error={err("providerId", !!providers.data)}>
                  <Select id={`${id}-p`} value={d.providerId || undefined} placeholder="Pick a provider" onValueChange={(v) => set("providerId", v)} options={(providers.data ?? []).map((p) => ({ value: p.id, label: p.displayName }))} data-testid="model-provider" />
                </Field>
                <Field label="Kind" htmlFor={`${id}-k`}>
                  <Select id={`${id}-k`} value={d.kind} onValueChange={(v) => set("kind", v as ModelKind)} options={MODEL_KINDS.map((k) => ({ value: k.kind, label: k.label }))} data-testid="model-kind" />
                </Field>
                <Field label="Model id" htmlFor={`${id}-ref`} hint="Exactly as the provider names it, such as gpt-4o-mini." error={err("modelRef", d.modelRef !== "")}>
                  <Input id={`${id}-ref`} value={d.modelRef} maxLength={120} onChange={(e) => set("modelRef", e.target.value)} className="font-mono" autoComplete="off" data-testid="model-ref" />
                </Field>
                <Field label="Display name" htmlFor={`${id}-name`} error={err("displayName", d.displayName !== "")}>
                  <Input id={`${id}-name`} value={d.displayName} maxLength={60} onChange={(e) => set("displayName", e.target.value)} data-testid="model-name" />
                </Field>
              </div>
              <Field label="Description" htmlFor={`${id}-desc`} optional hint="One line shown in the model picker.">
                <Textarea id={`${id}-desc`} rows={2} maxLength={200} value={d.description} onChange={(e) => set("description", e.target.value)} data-testid="model-description" />
              </Field>
              {d.kind === "CHAT" ? (
                <fieldset>
                  <legend className="text-sm font-medium text-foreground">Supports</legend>
                  <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
                    {(
                      [
                        ["supportsVision", "Images in messages"],
                        ["supportsTools", "Tools (web search, image creation)"],
                        ["supportsReasoning", "Reasoning"],
                      ] as const
                    ).map(([k, label]) => (
                      <label key={k} className="inline-flex items-center gap-2 text-[14px]">
                        <Checkbox checked={d[k]} onCheckedChange={(v) => set(k, v === true)} data-testid={`model-${k}`} />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Context window" htmlFor={`${id}-ctx`} error={errs.contextWindow}>
                  <Input id={`${id}-ctx`} inputMode="numeric" value={d.contextWindow} onChange={(e) => set("contextWindow", e.target.value)} data-testid="model-context" />
                </Field>
                <Field label="Max output" htmlFor={`${id}-out`} error={errs.maxOutputTokens}>
                  <Input id={`${id}-out`} inputMode="numeric" value={d.maxOutputTokens} onChange={(e) => set("maxOutputTokens", e.target.value)} data-testid="model-max-output" />
                </Field>
                <Field label="Sort order" htmlFor={`${id}-sort`} error={errs.sortOrder} hint="Lower comes first.">
                  <Input id={`${id}-sort`} inputMode="numeric" value={d.sortOrder} onChange={(e) => set("sortOrder", e.target.value)} data-testid="model-sort" />
                </Field>
              </div>
              <Field
                label="Weight"
                htmlFor={`${id}-w`}
                error={errs.weight}
                hint="Tokens on this model are multiplied by the weight before they count against daily allowances. Use 1 for a typical model, more for an expensive one, less for a cheap one."
              >
                <Input id={`${id}-w`} inputMode="decimal" value={d.weight} onChange={(e) => set("weight", e.target.value)} className="w-32" data-testid="model-weight" />
              </Field>
              <div className="space-y-3 border-t border-border pt-4">
                <label className="flex items-center justify-between gap-4 text-[14px]">
                  <span>
                    <span className="font-medium">Enabled</span>
                    <span className="block text-[13px] text-muted-foreground">People can pick it.</span>
                  </span>
                  <Switch checked={d.enabled} onCheckedChange={(v) => set("enabled", v)} data-testid="model-enabled" />
                </label>
                <label className="flex items-center justify-between gap-4 text-[14px]">
                  <span>
                    <span className="font-medium">Default</span>
                    <span className="block text-[13px] text-muted-foreground">Used for new conversations. One default per kind.</span>
                  </span>
                  <Switch checked={d.isDefault} onCheckedChange={(v) => set("isDefault", v)} data-testid="model-default" />
                </label>
              </div>
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
              <Button type="submit" disabled={!ok} loading={save.isPending} data-testid="model-save">
                {existing ? "Save" : "Add model"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
