"use client";

/** A project: its chats, its instructions and knowledge files, and a composer that starts a chat inside it. */
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import type { ProjectDetail } from "@open-chat/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Textarea, toast } from "@open-chat/ui";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { NotFoundState } from "@/components/common/states";
import { TimeAgo } from "@/components/common/time-ago";
import { api } from "@/lib/api";
import { useConversations, useProject } from "@/lib/chat/queries";
import { errorMessage } from "@/lib/errors";
import { qk } from "@/lib/query-keys";
import { ChatView } from "./chat-view";

function Knowledge({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const [instructions, setInstructions] = useState(project.instructions);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (p: ProjectDetail) => qc.setQueryData(qk.project(project.id), p);

  const save = async () => {
    if (instructions === project.instructions) return;
    setSaving(true);
    try {
      set(await api().projects.update(project.id, { instructions }));
    } catch (err) {
      toast.error({ title: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };
  const upload = async (files: File[]) => {
    for (const f of files) {
      setUploading((u) => [...u, f.name]);
      try {
        const file = await api().files.upload({ purpose: "PROJECT", file: f });
        set(await api().projects.addFile(project.id, file.id));
      } catch (err) {
        toast.error({ title: `${f.name}: ${errorMessage(err)}` });
      } finally {
        setUploading((u) => u.filter((n) => n !== f.name));
      }
    }
  };

  return (
    <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-subtle-foreground">Instructions</h2>
          {saving ? <span className="text-[12px] text-subtle-foreground">Saving</span> : null}
        </div>
        <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} onBlur={() => void save()} rows={5} maxLength={4000} placeholder="How should the assistant work in this project? For example: answer as our support lead, cite the policy documents." className="mt-2 text-[14px]" />
      </section>
      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-subtle-foreground">Files</h2>
          <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1 text-[13px] font-medium text-link">
            <Plus className="size-3.5" /> Add files
          </button>
          <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.json,text/*" onChange={(e) => (void upload(Array.from(e.target.files ?? [])), (e.target.value = ""))} />
        </div>
        <ul className="mt-2 divide-y divide-border border-y border-border">
          {project.files.map((f) => (
            <li key={f.id} className="group flex items-center gap-2.5 py-2 text-[14px]">
              <FileText className="size-4 shrink-0 text-brand" />
              <span className="min-w-0 flex-1 truncate">{f.fileName}</span>
              <span className="text-[12px] text-subtle-foreground">{f.status === "READY" ? (f.pageCount ? `${f.pageCount} pages` : "") : f.status === "REJECTED" ? "Could not read" : "Reading"}</span>
              <button type="button" aria-label={`Remove ${f.fileName}`} onClick={() => void api().projects.removeFile(project.id, f.id).then(set)} className="inline-flex size-6 items-center justify-center rounded-md text-subtle-foreground opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100">
                <X className="size-4" />
              </button>
            </li>
          ))}
          {uploading.map((n) => (
            <li key={n} className="flex items-center gap-2.5 py-2 text-[14px] text-subtle-foreground">
              <Loader2 className="size-4 animate-spin" /> {n}
            </li>
          ))}
          {!project.files.length && !uploading.length ? <li className="py-2 text-[13.5px] text-subtle-foreground">Add documents the assistant should know about. It searches them when they are relevant.</li> : null}
        </ul>
      </section>
    </div>
  );
}

export function ProjectView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const project = useProject(projectId);
  const chats = useConversations({ projectId });
  const [confirm, setConfirm] = useState(false);
  if (project.isError) return <NotFoundState title="This project is not available" />;
  const list = chats.data?.pages.flatMap((p) => p.items) ?? [];
  const p = project.data;
  return (
    <ChatView
      conversationId={null}
      projectId={projectId}
      emptyTitle={p?.name ?? " "}
      header={
        p ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Project options" className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted">
                <MoreHorizontal className="size-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  const name = window.prompt("Project name", p.name)?.trim();
                  if (name && name !== p.name) void api().projects.update(p.id, { name }).then((d) => (qc.setQueryData(qk.project(p.id), d), qc.invalidateQueries({ queryKey: qk.projects })));
                }}
              >
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem className="text-danger focus:text-danger" onSelect={() => setConfirm(true)}>
                <Trash2 className="size-4" /> Delete project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null
      }
      emptyContent={
        p ? (
          <div className="mt-10 w-full max-w-[760px] space-y-10">
            <Knowledge project={p} />
            <section>
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-subtle-foreground">Chats in this project</h2>
              {list.length ? (
                <ul className="mt-2 divide-y divide-border border-y border-border">
                  {list.map((c) => (
                    <li key={c.id}>
                      <Link href={`/c/${c.id}`} className="flex items-baseline justify-between gap-4 py-3 hover:text-primary">
                        <span className="truncate text-[14.5px] font-medium">{c.title}</span>
                        <TimeAgo value={c.lastMessageAt} className="shrink-0 text-[12.5px] text-subtle-foreground" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[14px] text-subtle-foreground">Start a chat above. It will use this project&apos;s instructions and files.</p>
              )}
            </section>
            <ConfirmDialog
              open={confirm}
              onOpenChange={setConfirm}
              title="Delete this project?"
              description="Its files are deleted. Its chats are kept and move out of the project."
              confirmLabel="Delete project"
              destructive
              onConfirm={async () => {
                await api().projects.remove(p.id);
                await qc.invalidateQueries({ queryKey: qk.projects });
                router.push("/");
              }}
            />
          </div>
        ) : (
          <div className="mt-10 h-40 w-full max-w-[760px] animate-pulse rounded-xl bg-muted" />
        )
      }
    />
  );
}

