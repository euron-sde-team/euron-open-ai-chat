"use client";

/**
 * Settings: how answers are shaped (model, style, search, voice), what the assistant
 * should know about you, memory, your data (shared links, export, delete chats), and
 * the account (profile, security, deletion).
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Menu, Trash2 } from "lucide-react";
import type { AnswerStyle, Memory, Preferences } from "@open-chat/types";
import { Avatar, Button, cn, Input, NativeSelect, Switch, Textarea, toast } from "@open-chat/ui";
import { PrivacySection } from "@/components/account/privacy-section";
import { SecuritySection } from "@/components/account/security-section";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { api } from "@/lib/api";
import { useAuth, useMe } from "@/lib/auth";
import { useMemories, useModels, usePreferences, useUsage } from "@/lib/chat/queries";
import { errorMessage } from "@/lib/errors";
import { useAppMeta } from "@/lib/meta";
import { qk } from "@/lib/query-keys";
import { useTheme, type ThemePref } from "@/lib/stores/theme";
import { useShell } from "./shell-context";

type Tab = "general" | "personalization" | "memory" | "data" | "account";
const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "personalization", label: "Personalization" },
  { id: "memory", label: "Memory" },
  { id: "data", label: "Data controls" },
  { id: "account", label: "Account" },
];

function Row({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-border py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[14.5px] font-medium">{title}</p>
        {description ? <p className="mt-0.5 max-w-md text-[13.5px] text-muted-foreground">{description}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function usePrefsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Preferences>) => api().me.updatePreferences(patch),
    onMutate: (patch) => qc.setQueryData<Preferences>(qk.preferences, (p) => (p ? { ...p, ...patch } : p)),
    onSuccess: (p) => qc.setQueryData(qk.preferences, p),
    onError: () => void qc.invalidateQueries({ queryKey: qk.preferences }),
  });
}

function General() {
  const prefs = usePreferences();
  const models = useModels();
  const meta = useAppMeta();
  const usage = useUsage();
  const save = usePrefsMutation();
  const { pref, setPref } = useTheme();
  const p = prefs.data;
  if (!p) return <div className="h-40 animate-pulse rounded-xl bg-muted" />;
  return (
    <div>
      <Row title="Theme">
        <NativeSelect aria-label="Theme" value={pref} onChange={(e) => setPref(e.target.value as ThemePref)} className="w-40">
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </NativeSelect>
      </Row>
      <Row title="Default model" description="Used for new chats. You can switch models in any chat.">
        <NativeSelect aria-label="Default model" value={p.defaultModelId ?? ""} onChange={(e) => save.mutate({ defaultModelId: e.target.value || null })} className="w-56">
          <option value="">The deployment&apos;s default</option>
          {models.data?.chat.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </NativeSelect>
      </Row>
      <Row title="Answer length" description="How long answers should be when you do not say.">
        <NativeSelect aria-label="Answer length" value={p.answerStyle} onChange={(e) => save.mutate({ answerStyle: e.target.value as AnswerStyle })} className="w-40">
          <option value="CONCISE">Concise</option>
          <option value="BALANCED">Balanced</option>
          <option value="DETAILED">Detailed</option>
        </NativeSelect>
      </Row>
      {meta.data?.features.webSearch ? (
        <Row title="Search the web by default" description="The assistant looks things up when a question needs fresh information. You can turn it off per message.">
          <Switch checked={p.webSearchDefault} onCheckedChange={(v) => save.mutate({ webSearchDefault: v })} aria-label="Search the web by default" />
        </Row>
      ) : null}
      {meta.data?.features.readAloud ? (
        <Row title="Voice" description="The voice that reads answers aloud.">
          <NativeSelect aria-label="Voice" value={p.voice} onChange={(e) => save.mutate({ voice: e.target.value })} className="w-40">
            {["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"].map((v) => (
              <option key={v} value={v}>
                {v[0]!.toUpperCase() + v.slice(1)}
              </option>
            ))}
          </NativeSelect>
        </Row>
      ) : null}
      {usage.data ? (
        <Row title="Today's use" description={`Resets at ${new Date(usage.data.resetsAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}. Larger models count for more.`}>
          <div className="text-right text-[13.5px] tabular-nums">
            <p>{usage.data.tokens.limit === null ? `${usage.data.tokens.used.toLocaleString()} tokens` : `${usage.data.tokens.used.toLocaleString()} of ${usage.data.tokens.limit.toLocaleString()} tokens`}</p>
            <p className="text-muted-foreground">{usage.data.images.limit === null ? `${usage.data.images.used} images` : `${usage.data.images.used} of ${usage.data.images.limit} images`}</p>
          </div>
        </Row>
      ) : null}
    </div>
  );
}

function Personalization() {
  const prefs = usePreferences();
  const save = usePrefsMutation();
  const [about, setAbout] = useState("");
  const [how, setHow] = useState("");
  const loaded = useRef(false);
  useEffect(() => {
    if (prefs.data && !loaded.current) {
      loaded.current = true;
      setAbout(prefs.data.aboutMe);
      setHow(prefs.data.customInstructions);
    }
  }, [prefs.data]);
  const dirty = !!prefs.data && (about !== prefs.data.aboutMe || how !== prefs.data.customInstructions);
  return (
    <div className="space-y-6 py-5">
      <div className="space-y-2">
        <label htmlFor="about" className="text-[14.5px] font-medium">
          What should the assistant know about you?
        </label>
        <Textarea id="about" value={about} onChange={(e) => setAbout(e.target.value)} rows={4} maxLength={1500} placeholder="I am a product manager at a software company. I prefer metric units." />
        <p className="text-right text-[12px] tabular-nums text-subtle-foreground">{about.length} / 1500</p>
      </div>
      <div className="space-y-2">
        <label htmlFor="how" className="text-[14.5px] font-medium">
          How should it respond?
        </label>
        <Textarea id="how" value={how} onChange={(e) => setHow(e.target.value)} rows={4} maxLength={1500} placeholder="Be direct. Use tables when comparing options. Avoid filler." />
        <p className="text-right text-[12px] tabular-nums text-subtle-foreground">{how.length} / 1500</p>
      </div>
      <div className="flex justify-end">
        <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate({ aboutMe: about, customInstructions: how }, { onSuccess: () => toast.success({ title: "Saved" }) })}>
          Save
        </Button>
      </div>
    </div>
  );
}

function MemoryTab() {
  const qc = useQueryClient();
  const prefs = usePreferences();
  const save = usePrefsMutation();
  const memories = useMemories();
  const meta = useAppMeta();
  const [draft, setDraft] = useState("");
  const [clearing, setClearing] = useState(false);
  const set = (fn: (m: Memory[]) => Memory[]) => qc.setQueryData<Memory[]>(qk.memories, (m) => fn(m ?? []));
  if (meta.data && !meta.data.features.memory) return <p className="py-5 text-[14px] text-muted-foreground">Memory is turned off for this deployment.</p>;
  return (
    <div>
      <Row title="Use memory" description="The assistant remembers useful things you tell it and uses them in new chats. It never stores passwords or secrets.">
        <Switch checked={!!prefs.data?.memoryEnabled} onCheckedChange={(v) => save.mutate({ memoryEnabled: v })} aria-label="Use memory" />
      </Row>
      <form
        className="flex gap-2 py-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          void api()
            .memories.add(draft.trim())
            .then((m) => (set((list) => [m, ...list]), setDraft("")))
            .catch((err) => toast.error({ title: errorMessage(err) }));
        }}
      >
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={500} placeholder="Add something to remember" aria-label="New memory" />
        <Button type="submit" variant="secondary" disabled={!draft.trim()}>
          Add
        </Button>
      </form>
      <ul className="divide-y divide-border border-y border-border">
        {memories.data?.map((m) => (
          <li key={m.id} className="group flex items-start gap-3 py-3">
            <p className="min-w-0 flex-1 text-[14.5px]">{m.content}</p>
            <span className="shrink-0 pt-0.5 text-[12px] text-subtle-foreground">{m.source === "ASSISTANT" ? "Saved by the assistant" : "Added by you"}</span>
            <button type="button" aria-label="Forget" onClick={() => void api().memories.remove(m.id).then(() => set((list) => list.filter((x) => x.id !== m.id)))} className="shrink-0 rounded-md p-1 text-subtle-foreground hover:text-danger">
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
        {memories.data && !memories.data.length ? <li className="py-3 text-[14px] text-subtle-foreground">Nothing remembered yet.</li> : null}
      </ul>
      {memories.data?.length ? (
        <div className="pt-4">
          <Button variant="danger-ghost" onClick={() => setClearing(true)}>
            Forget everything
          </Button>
        </div>
      ) : null}
      <ConfirmDialog open={clearing} onOpenChange={setClearing} title="Forget every memory?" description="The assistant will not remember anything from earlier chats. This cannot be undone." confirmLabel="Forget everything" destructive onConfirm={() => api().memories.clear().then(() => set(() => []))} />
    </div>
  );
}

function DataControls() {
  const qc = useQueryClient();
  const shares = useQuery({ queryKey: qk.shares, queryFn: () => api().shares.list() });
  const [deleting, setDeleting] = useState(false);
  const live = shares.data?.filter((s) => !s.revoked) ?? [];
  return (
    <div>
      <div className="py-5">
        <p className="text-[14.5px] font-medium">Shared links</p>
        <p className="mt-0.5 text-[13.5px] text-muted-foreground">Anyone with a link can read that chat as it was when you shared it.</p>
        <ul className="mt-3 divide-y divide-border border-y border-border">
          {live.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2.5 text-[14px]">
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-medium hover:underline">
                {s.title}
              </a>
              <span className="text-[12.5px] tabular-nums text-subtle-foreground">{s.viewCount} views</span>
              <Button size="sm" variant="ghost" onClick={() => void api().shares.revoke(s.id).then(() => qc.invalidateQueries({ queryKey: qk.shares }))}>
                Revoke
              </Button>
            </li>
          ))}
          {shares.data && !live.length ? <li className="py-2.5 text-[14px] text-subtle-foreground">No shared links.</li> : null}
        </ul>
      </div>
      <Row title="Delete all chats" description="Every conversation and its attachments. Images stay in your gallery until you remove them.">
        <Button variant="danger-ghost" onClick={() => setDeleting(true)}>
          Delete all
        </Button>
      </Row>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete every chat?"
        description="All conversations are deleted for good. Shared links keep working until you revoke them."
        confirmLabel="Delete all chats"
        destructive
        onConfirm={async () => {
          const { deleted } = await api().chats.removeAll();
          await qc.invalidateQueries({ queryKey: qk.chatsAll });
          toast.success({ title: `${deleted} chats deleted` });
        }}
      />
    </div>
  );
}

function Profile() {
  const me = useMe();
  const { setUser } = useAuth();
  const [name, setName] = useState(me.displayName);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const saveName = async () => {
    setBusy(true);
    try {
      setUser(await api().users.updateMe({ displayName: name }));
      toast.success({ title: "Saved" });
    } catch (err) {
      toast.error({ title: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  const uploadAvatar = async (f: File) => {
    try {
      const file = await api().files.upload({ purpose: "AVATAR", file: f });
      setUser(await api().users.updateMe({ avatarFileId: file.id }));
    } catch (err) {
      toast.error({ title: errorMessage(err) });
    }
  };
  return (
    <div className="flex flex-col gap-5 border-b border-border py-6 sm:flex-row sm:items-center">
      <button type="button" onClick={() => fileRef.current?.click()} className="self-start rounded-full" aria-label="Change picture">
        <Avatar name={me.displayName} src={me.avatarUrl} size="lg" />
      </button>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => e.target.files?.[0] && void uploadAvatar(e.target.files[0])} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-muted-foreground">{me.email}</p>
        <div className="mt-2 flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Name" className="max-w-xs" />
          <Button variant="secondary" disabled={!name.trim() || name === me.displayName} loading={busy} onClick={() => void saveName()}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SettingsView() {
  const shell = useShell();
  const [tab, setTab] = useState<Tab>("general");
  return (
    <div className="h-full overflow-y-auto">
      <header className="flex h-14 items-center gap-1 px-2 sm:px-3">
        {shell.collapsed || shell.mobile ? (
          <button type="button" aria-label="Open sidebar" onClick={shell.open} className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted">
            <Menu className="size-5" />
          </button>
        ) : null}
      </header>
      <div className="mx-auto w-full max-w-[860px] px-4 pb-20 sm:px-6">
        <h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">Settings</h1>
        <div className="mt-6 flex gap-5 overflow-x-auto border-b border-border" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("-mb-px shrink-0 border-b-2 pb-2.5 text-[14.5px] font-medium transition-colors", tab === t.id ? "border-ink text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="mt-2">
          {tab === "general" ? <General /> : null}
          {tab === "personalization" ? <Personalization /> : null}
          {tab === "memory" ? <MemoryTab /> : null}
          {tab === "data" ? <DataControls /> : null}
          {tab === "account" ? (
            <div>
              <Profile />
              <div className="pt-6">
                <SecuritySection />
              </div>
              <div className="pt-10">
                <PrivacySection />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
