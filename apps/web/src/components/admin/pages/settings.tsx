"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button, Field, Input, Select, Skeleton, Switch, Textarea, toast } from "@open-chat/ui";
import type { AnswerStyle, ChatSettings, IntegrationStatus } from "@open-chat/types";
import { api } from "@/lib/api";
import { adminErrorMessage, dirtyGroups, parseDomains, settingsErrors, settingsPatch, type SettingsGroup } from "@/lib/admin";
import { qk } from "@/lib/query-keys";
import { ErrorState } from "@/components/common/states";
import { AdminPage, AdminSection, FactList, StatusText } from "../shell";
import { adminMutation, ak, LineItem } from "./common";

/** The form's text fields, kept as typed (an empty box means null). */
interface Form extends Omit<ChatSettings, "retentionDays" | "supportEmail" | "minSupportedVersion"> {
  retentionDays: string;
  supportEmail: string;
  minSupportedVersion: string;
}

export const toForm = (s: ChatSettings): Form => ({ ...s, retentionDays: s.retentionDays === null ? "" : String(s.retentionDays), supportEmail: s.supportEmail ?? "", minSupportedVersion: s.minSupportedVersion ?? "" });

export const fromForm = (f: Form): ChatSettings => ({
  ...f,
  retentionDays: f.retentionDays.trim() === "" ? null : Number(f.retentionDays.trim()),
  supportEmail: f.supportEmail.trim() || null,
  minSupportedVersion: f.minSupportedVersion.trim() || null,
});

const GROUP_LABEL: Record<SettingsGroup, string> = { general: "General", signup: "Sign-up", features: "Features", assistant: "Assistant", data: "Data", mobile: "Mobile" };

const FEATURES: { key: keyof ChatSettings["features"]; title: string; description: string }[] = [
  { key: "webSearch", title: "Web search", description: "The assistant can look things up and cite sources." },
  { key: "imageGeneration", title: "Image generation", description: "People can ask for images." },
  { key: "dictation", title: "Dictation", description: "Speak instead of typing in the message box." },
  { key: "readAloud", title: "Read aloud", description: "Answers can be played as speech." },
  { key: "memory", title: "Memory", description: "The assistant remembers facts people ask it to keep." },
  { key: "projects", title: "Projects", description: "Group conversations with shared files and instructions." },
  { key: "sharing", title: "Sharing", description: "People can share a read-only link to a conversation." },
];

const ANSWER_STYLES: { value: AnswerStyle; label: string }[] = [
  { value: "CONCISE", label: "Concise" },
  { value: "BALANCED", label: "Balanced" },
  { value: "DETAILED", label: "Detailed" },
];

export function AdminSettings() {
  const q = useQuery({ queryKey: ak.settings, queryFn: () => api().admin.settings() });
  return (
    <AdminPage title="Settings" description="How this deployment behaves for everyone. Changes apply right away and are recorded in the audit log." testId="admin-settings">
      {q.isError && !q.data ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.data ? <SettingsForm saved={q.data} /> : <FormSkeleton />}
      <Integrations />
    </AdminPage>
  );
}

function SettingsForm({ saved }: { saved: ChatSettings }) {
  const id = useId();
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(() => toForm(saved));
  const [domainText, setDomainText] = useState("");
  const [domainError, setDomainError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A save (or a refetch) replaces the baseline; the draft follows it.
  useEffect(() => setForm(toForm(saved)), [saved]);

  const draft = useMemo(() => fromForm(form), [form]);
  const errs = settingsErrors(draft);
  const dirty = dirtyGroups(saved, draft);
  const valid = Object.keys(errs).length === 0;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => api().admin.updateSettings(settingsPatch(saved, draft)),
    ...adminMutation({ inline: true }),
    onMutate: () => setError(null),
    onError: (e) => setError(adminErrorMessage(e)),
    onSuccess: (next) => {
      qc.setQueryData(ak.settings, next);
      void qc.invalidateQueries({ queryKey: qk.meta });
      toast.success({ title: "Settings saved" });
    },
  });

  const addDomains = () => {
    const { added, invalid } = parseDomains(domainText, form.allowedEmailDomains);
    if (added.length) set("allowedEmailDomains", [...form.allowedEmailDomains, ...added]);
    setDomainError(invalid.length ? `Not a domain: ${invalid.join(", ")}` : null);
    setDomainText(invalid.join(" "));
  };

  const forever = form.retentionDays.trim() === "";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && dirty.length) save.mutate();
      }}
      data-testid="settings-form"
    >
      <AdminSection title="General" id="general">
        <div className="grid max-w-2xl gap-4">
          <Field label="App name" htmlFor={`${id}-name`} error={errs.appName} hint="Shown in the header, page titles and emails.">
            <Input id={`${id}-name`} value={form.appName} maxLength={60} onChange={(e) => set("appName", e.target.value)} data-testid="settings-app-name" />
          </Field>
          <Field label="Tagline" htmlFor={`${id}-tagline`} optional error={errs.tagline}>
            <Input id={`${id}-tagline`} value={form.tagline} maxLength={160} onChange={(e) => set("tagline", e.target.value)} data-testid="settings-tagline" />
          </Field>
          <Field label="Support email" htmlFor={`${id}-support`} optional error={errs.supportEmail} hint="Where people can write for help.">
            <Input id={`${id}-support`} type="email" value={form.supportEmail} maxLength={200} onChange={(e) => set("supportEmail", e.target.value)} data-testid="settings-support-email" />
          </Field>
        </div>
      </AdminSection>

      <AdminSection title="Sign-up" id="signup">
        <div className="grid max-w-2xl gap-4">
          <Field label="Who can create an account" htmlFor={`${id}-reg`}>
            <Select
              id={`${id}-reg`}
              value={form.registration}
              onValueChange={(v) => set("registration", v as ChatSettings["registration"])}
              options={[
                { value: "OPEN", label: "Anyone" },
                { value: "INVITE_ONLY", label: "Only people with an allowed email domain" },
                { value: "CLOSED", label: "No one: sign-up is closed" },
              ]}
              data-testid="settings-registration"
            />
          </Field>
          <Field
            label="Allowed email domains"
            htmlFor={`${id}-domains`}
            optional={form.registration !== "INVITE_ONLY"}
            error={domainError ?? errs.allowedEmailDomains}
            hint={form.registration === "INVITE_ONLY" ? "Only addresses at these domains can sign up." : "Used when sign-up is limited to allowed domains."}
          >
            <div className="flex gap-2">
              <Input
                id={`${id}-domains`}
                value={domainText}
                placeholder="example.com"
                onChange={(e) => setDomainText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addDomains();
                  }
                }}
                data-testid="settings-domain-input"
              />
              <Button type="button" variant="outline" onClick={addDomains} disabled={!domainText.trim()} data-testid="settings-domain-add">
                Add
              </Button>
            </div>
          </Field>
          {form.allowedEmailDomains.length ? (
            <ul className="divide-y divide-border border-y border-border" aria-label="Allowed email domains" data-testid="settings-domains">
              {form.allowedEmailDomains.map((d) => (
                <li key={d} className="flex items-center justify-between gap-3 py-2 text-[14px]">
                  <span className="min-w-0 break-all font-mono text-[13px]">{d}</span>
                  <button
                    type="button"
                    onClick={() => set("allowedEmailDomains", form.allowedEmailDomains.filter((x) => x !== d))}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Remove ${d}`}
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </AdminSection>

      <AdminSection title="Features" id="features" description="Turned off, a feature disappears from every app.">
        <div className="max-w-2xl">
          {FEATURES.map((f) => (
            <LineItem
              key={f.key}
              title={<label htmlFor={`${id}-f-${f.key}`}>{f.title}</label>}
              description={f.description}
              control={<Switch id={`${id}-f-${f.key}`} checked={form.features[f.key]} onCheckedChange={(v) => set("features", { ...form.features, [f.key]: v })} data-testid={`settings-feature-${f.key}`} />}
            />
          ))}
        </div>
      </AdminSection>

      <AdminSection title="Assistant" id="assistant">
        <div className="grid max-w-2xl gap-4">
          <Field
            label="House instructions"
            htmlFor={`${id}-prompt`}
            optional
            error={errs.systemPromptAddendum}
            hint={`Added to every conversation, for everyone, before their own instructions. ${form.systemPromptAddendum.length} of 4,000 characters.`}
          >
            <Textarea id={`${id}-prompt`} rows={6} value={form.systemPromptAddendum} onChange={(e) => set("systemPromptAddendum", e.target.value)} placeholder="For example: answer in British English and point to the internal wiki for HR questions." data-testid="settings-prompt" />
          </Field>
          <Field label="Default answer style" htmlFor={`${id}-style`} hint="People can change it for themselves.">
            <Select id={`${id}-style`} value={form.defaults.answerStyle} onValueChange={(v) => set("defaults", { ...form.defaults, answerStyle: v as AnswerStyle })} options={ANSWER_STYLES} className="sm:w-56" data-testid="settings-answer-style" />
          </Field>
        </div>
      </AdminSection>

      <AdminSection title="Data" id="data">
        <div className="max-w-2xl">
          <LineItem
            title={<label htmlFor={`${id}-forever`}>Keep conversations forever</label>}
            description="Turned off, conversations nobody has opened for the number of days below are deleted."
            control={<Switch id={`${id}-forever`} checked={forever} onCheckedChange={(v) => set("retentionDays", v ? "" : "365")} data-testid="settings-keep-forever" />}
          />
          {!forever ? (
            <Field label="Delete after this many days" htmlFor={`${id}-ret`} error={errs.retentionDays} className="pt-3">
              <Input id={`${id}-ret`} inputMode="numeric" value={form.retentionDays} onChange={(e) => set("retentionDays", e.target.value)} className="w-32" data-testid="settings-retention" />
            </Field>
          ) : null}
        </div>
      </AdminSection>

      <AdminSection title="Mobile" id="mobile">
        <div className="max-w-2xl">
          <Field label="Minimum supported app version" htmlFor={`${id}-ver`} optional error={errs.minSupportedVersion} hint="Older mobile apps are asked to update. Leave empty to allow every version.">
            <Input id={`${id}-ver`} value={form.minSupportedVersion} placeholder="1.4.0" onChange={(e) => set("minSupportedVersion", e.target.value)} className="w-40 font-mono" data-testid="settings-min-version" />
          </Field>
        </div>
      </AdminSection>

      {dirty.length || error ? (
        <div className="sticky bottom-0 z-30 -mx-4 mt-8 border-t border-border bg-background/90 backdrop-blur-xl sm:-mx-6" data-testid="settings-save-bar">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <p className="min-w-0 text-[13.5px]" aria-live="polite">
              {error ? (
                <span role="alert" className="font-medium text-danger">
                  {error}
                </span>
              ) : (
                <span className="text-muted-foreground">Unsaved changes in {listJoin(dirty.map((g) => GROUP_LABEL[g]))}.</span>
              )}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setForm(toForm(saved));
                  setError(null);
                  setDomainError(null);
                  setDomainText("");
                }}
                disabled={save.isPending}
                data-testid="settings-discard"
              >
                Discard
              </Button>
              <Button type="submit" disabled={!valid || !dirty.length} loading={save.isPending} data-testid="settings-save">
                Save changes
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}

const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const SEARCH_LABEL: Record<IntegrationStatus["search"]["provider"], string> = { searxng: "SearXNG", tavily: "Tavily", exa: "Exa", brave: "Brave", stub: "Local stub", none: "None" };

function Integrations() {
  const q = useQuery({ queryKey: ak.integrations, queryFn: () => api().admin.integrations(), staleTime: 5 * 60_000 });
  const i = q.data;
  const on = (v: boolean, yes: ReactNode = "Configured", no: ReactNode = "Not configured") => (v ? <StatusText tone="success">{yes}</StatusText> : <StatusText tone="muted">{no}</StatusText>);
  return (
    <AdminSection title="Integrations" id="integrations" description="What the server is set up with, from its environment. Change these in the server's configuration and restart it.">
      {q.isError && !i ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : !i ? (
        <div className="max-w-2xl space-y-2" aria-busy>
          {Array.from({ length: 5 }, (_, n) => (
            <Skeleton key={n} className="h-5 w-2/3" />
          ))}
        </div>
      ) : (
        <FactList
          className="max-w-2xl"
          items={[
            { label: "Web search", value: <span className="inline-flex flex-wrap items-center gap-x-2">{SEARCH_LABEL[i.search.provider]} {i.search.provider !== "none" ? on(i.search.configured) : null}</span> },
            { label: "Moderation", value: i.moderation.provider === "none" ? "Off" : i.moderation.provider === "openai" ? "OpenAI" : "Local stub" },
            { label: "Speech to text", value: on(i.speech.transcribe, "Available", "Not available") },
            { label: "Text to speech", value: on(i.speech.tts, "Available", "Not available") },
            { label: "Email", value: i.mail.mode === "outbox" ? "Outbox: written to disk on the server, not sent" : i.mail.mode === "smtp" ? "SMTP" : "Amazon SES" },
            { label: "File storage", value: i.storage.mode === "local" ? "Local disk" : "S3" },
          ]}
        />
      )}
    </AdminSection>
  );
}

function FormSkeleton() {
  return (
    <div className="max-w-2xl space-y-6 border-t border-border pt-6" aria-busy>
      {Array.from({ length: 4 }, (_, n) => (
        <div key={n} className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-full" />
        </div>
      ))}
    </div>
  );
}
