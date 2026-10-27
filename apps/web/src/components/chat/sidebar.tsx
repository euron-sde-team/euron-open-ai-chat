"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Archive, Check, FolderClosed, FolderPlus, Images, LogOut, MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Search, Settings, Share2, Shield, SquarePen, Trash2, X, Monitor, Moon, Sun } from "lucide-react";
import type { ConversationSummary } from "@open-chat/types";
import {
  Avatar,
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Textarea,
  Tooltip,
} from "@open-chat/ui";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { LogoMark } from "@/components/common/wordmark";
import { useAuth } from "@/lib/auth";
import { useChatActions, useCreateProject } from "@/lib/chat/actions";
import { groupByDate, useConversations, usePinned, useProjects, useUsage } from "@/lib/chat/queries";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useProductName } from "@/lib/meta";
import { useTheme } from "@/lib/stores/theme";
import { ShareDialog } from "./share-dialog";

function Row({ c, active, onShare }: { c: ConversationSummary; active: boolean; onShare: (c: ConversationSummary) => void }) {
  const { update, remove } = useChatActions();
  const { data: projects } = useProjects();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(c.title);
  const [confirm, setConfirm] = useState(false);
  const [moving, setMoving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  if (renaming) {
    const save = () => {
      setRenaming(false);
      if (title.trim() && title.trim() !== c.title) update.mutate({ id: c.id, title: title.trim() });
      else setTitle(c.title);
    };
    return (
      <div className="px-2 py-0.5">
        <input ref={inputRef} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={save} onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" ? (setTitle(c.title), setRenaming(false)) : null)} aria-label="Chat title" className="h-8 w-full rounded-lg border border-ring bg-card px-2 text-[14px] outline-none" maxLength={120} />
      </div>
    );
  }
  return (
    <div className={cn("group relative flex items-center rounded-lg", active ? "bg-muted" : "hover:bg-muted/70")}>
      <Link href={`/c/${c.id}`} className="min-w-0 flex-1 truncate py-1.5 pl-3 pr-8 text-[14px]" aria-current={active ? "page" : undefined} title={c.title}>
        {c.title}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`Options for ${c.title}`} className={cn("absolute right-1 inline-flex size-7 items-center justify-center rounded-md text-subtle-foreground transition-opacity hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100", active ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem onSelect={() => onShare(c)}>
            <Share2 className="size-4" /> Share
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil className="size-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => update.mutate({ id: c.id, pinned: !c.pinned })}>
            {c.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />} {c.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          {projects?.length ? (
            <DropdownMenuItem onSelect={() => setMoving(true)}>
              <FolderClosed className="size-4" /> Move to project
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => update.mutate({ id: c.id, archived: true })}>
            <Archive className="size-4" /> Archive
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setConfirm(true)} className="text-danger focus:text-danger">
            <Trash2 className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this chat?" description={`"${c.title}" and its files will be deleted. Shared links keep working until you revoke them.`} confirmLabel="Delete" destructive onConfirm={() => remove.mutateAsync(c.id)} />
      <Dialog open={moving} onOpenChange={setMoving}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Move to project</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-0.5">
            {c.projectId ? (
              <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[14px] hover:bg-muted" onClick={() => (update.mutate({ id: c.id, projectId: null }), setMoving(false))}>
                <X className="size-4 text-subtle-foreground" /> Remove from project
              </button>
            ) : null}
            {projects?.map((p) => (
              <button key={p.id} type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[14px] hover:bg-muted" onClick={() => (update.mutate({ id: c.id, projectId: p.id }), setMoving(false))}>
                <FolderClosed className="size-4 text-subtle-foreground" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.id === c.projectId ? <Check className="size-4 text-primary" /> : null}
              </button>
            ))}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useCreateProject();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name, instructions }, { onSuccess: () => (onOpenChange(false), setName(""), setInstructions("")) });
          }}
        >
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-name">Name</Label>
              <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus required placeholder="Q3 launch" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-instructions">Instructions</Label>
              <Textarea id="project-instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} maxLength={4000} placeholder="How the assistant should work in this project" />
              <p className="text-[12.5px] text-subtle-foreground">Used in every chat of the project, together with any files you add.</p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UsageLine() {
  const { data } = useUsage();
  if (!data?.tokens.limit) return null;
  const pct = Math.min(100, Math.round((data.tokens.used / data.tokens.limit) * 100));
  return (
    <div className="px-3 pb-2" title={`${data.tokens.used.toLocaleString()} of ${data.tokens.limit.toLocaleString()} tokens today`}>
      <div className="flex justify-between text-[12px] text-subtle-foreground">
        <span>Today</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="mt-1 h-[3px] rounded-full bg-border">
        <div className={cn("h-full rounded-full", pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-brand")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Sidebar({ onCollapse, onNavigate }: { onCollapse?: () => void; onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const name = useProductName();
  const { user, isAdmin, logout } = useAuth();
  const { pref, setPref } = useTheme();
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  const list = useConversations(q ? { q } : {});
  const pinned = usePinned();
  const projects = useProjects();
  const [newProject, setNewProject] = useState(false);
  const [sharing, setSharing] = useState<ConversationSummary | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const groups = useMemo(() => groupByDate(items), [items]);
  const activeId = pathname.startsWith("/c/") ? pathname.slice(3) : null;

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [list]);

  // Close the phone sheet after navigating, but not when it first opens (mount).
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    onNavigate?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <nav aria-label="Chats" className="flex h-full flex-col bg-ground-2/60">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <Link href="/" className="flex min-w-0 items-center gap-2 rounded-md" aria-label={`${name} home`}>
          <LogoMark className="size-7" />
          <span className="truncate font-display text-[15px] font-semibold tracking-[-0.01em]">{name}</span>
        </Link>
        {onCollapse ? (
          <Tooltip content="Close sidebar">
            <button type="button" onClick={onCollapse} aria-label="Close sidebar" className="inline-flex size-8 items-center justify-center rounded-lg text-subtle-foreground hover:bg-muted hover:text-foreground">
              <PanelLeftClose className="size-[18px]" />
            </button>
          </Tooltip>
        ) : null}
      </div>
      <div className="space-y-0.5 px-2">
        <button type="button" onClick={() => router.push("/")} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium hover:bg-muted">
          <SquarePen className="size-[18px]" /> New chat
        </button>
        <label className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] text-muted-foreground focus-within:bg-muted hover:bg-muted">
          <Search className="size-[18px] shrink-0" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" />
          {query ? (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
              <X className="size-4" />
            </button>
          ) : null}
        </label>
        <Link href="/images" className={cn("flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium hover:bg-muted", pathname === "/images" && "bg-muted")}>
          <Images className="size-[18px]" /> Images
        </Link>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {!q ? (
          <section className="mb-4">
            <div className="flex items-center justify-between px-2.5 pb-1">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle-foreground">Projects</h2>
              <Tooltip content="New project">
                <button type="button" aria-label="New project" onClick={() => setNewProject(true)} className="inline-flex size-6 items-center justify-center rounded-md text-subtle-foreground hover:bg-muted hover:text-foreground">
                  <FolderPlus className="size-4" />
                </button>
              </Tooltip>
            </div>
            {projects.data?.length ? (
              projects.data.map((p) => (
                <Link key={p.id} href={`/projects/${p.id}`} className={cn("flex items-center gap-2.5 truncate rounded-lg px-2.5 py-1.5 text-[14px] hover:bg-muted/70", pathname === `/projects/${p.id}` && "bg-muted")}>
                  <FolderClosed className="size-4 shrink-0 text-subtle-foreground" />
                  <span className="truncate">{p.name}</span>
                </Link>
              ))
            ) : (
              <p className="px-2.5 text-[13px] text-subtle-foreground">Group chats with shared instructions and files.</p>
            )}
          </section>
        ) : null}
        {!q && pinned.data?.length ? (
          <section className="mb-4">
            <h2 className="px-2.5 pb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle-foreground">Pinned</h2>
            {pinned.data.map((c) => (
              <Row key={c.id} c={c} active={c.id === activeId} onShare={setSharing} />
            ))}
          </section>
        ) : null}
        {groups.map((g) => (
          <section key={g.label} className="mb-4">
            <h2 className="px-2.5 pb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle-foreground">{q ? "Results" : g.label}</h2>
            {g.items.map((c) => (
              <Row key={c.id} c={c} active={c.id === activeId} onShare={setSharing} />
            ))}
          </section>
        ))}
        {list.isLoading ? (
          <div className="space-y-2 px-2.5">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-muted" style={{ width: `${55 + ((i * 17) % 40)}%` }} />
            ))}
          </div>
        ) : null}
        {!list.isLoading && !items.length ? <p className="px-2.5 text-[13px] text-subtle-foreground">{q ? "No chats match." : "Your chats will appear here."}</p> : null}
        <div ref={sentinel} className="h-4" />
      </div>

      <div className="border-t border-border pt-2">
        <UsageLine />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" data-testid="account-menu" aria-label="Account menu" className="mx-2 mb-2 flex w-[calc(100%-1rem)] items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-muted">
              <Avatar name={user?.displayName ?? "?"} src={user?.avatarUrl ?? undefined} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{user?.displayName}</span>
                <span className="block truncate text-[12px] text-subtle-foreground">{user?.email}</span>
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-60">
            <DropdownMenuItem onSelect={() => router.push("/settings")}>
              <Settings className="size-4" /> Settings
            </DropdownMenuItem>
            {isAdmin ? (
              <DropdownMenuItem onSelect={() => router.push("/admin")}>
                <Shield className="size-4" /> Admin
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle-foreground">Theme</DropdownMenuLabel>
            {(
              [
                ["system", "System", Monitor],
                ["light", "Light", Sun],
                ["dark", "Dark", Moon],
              ] as const
            ).map(([v, label, Icon]) => (
              <DropdownMenuItem key={v} onSelect={(e) => (e.preventDefault(), setPref(v))}>
                <Icon className="size-4" /> {label}
                {pref === v ? <Check className="ml-auto size-4 text-primary" /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="sign-out" onSelect={() => void logout()}>
              <LogOut className="size-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <NewProjectDialog open={newProject} onOpenChange={setNewProject} />
      {sharing ? <ShareDialog conversationId={sharing.id} title={sharing.title} open onOpenChange={(o) => !o && setSharing(null)} /> : null}
    </nav>
  );
}
