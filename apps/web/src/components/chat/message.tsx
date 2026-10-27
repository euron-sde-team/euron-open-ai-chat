"use client";

/**
 * One message. A question is a quiet bubble on the right; an answer is plain prose on the
 * page (no bubble), preceded by what the assistant did ("Searched the web") and followed
 * by its sources and a row of unboxed actions. Messages with siblings (edited questions,
 * regenerated answers) show a "2 / 3" switcher.
 */
import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronLeft, ChevronRight, Copy, FileText, Globe, Image as ImageIcon, Loader2, Pencil, RefreshCw, Search, ThumbsDown, ThumbsUp, Volume2, Square, Brain, BookOpen, Link2 } from "lucide-react";
import type { ChatFile, Message, ToolStep } from "@open-chat/types";
import { Button, cn, Textarea, Tooltip } from "@open-chat/ui";
import { Markdown } from "./markdown";

export interface MessageActions {
  onEdit?: (message: Message, content: string) => void;
  onRegenerate?: (message: Message) => void;
  onSwitch?: (messageId: string) => void;
  onFeedback?: (message: Message, value: 1 | -1 | null) => void;
  onSpeak?: (message: Message) => Promise<void> | void;
  onOpenImage?: (file: ChatFile) => void;
  speakingId?: string | null;
  readAloud?: boolean;
  errorOf?: (id: string) => string | null;
}

function Action({ label, onClick, children, active }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <Tooltip content={label}>
      <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} className={cn("inline-flex size-8 items-center justify-center rounded-lg text-subtle-foreground transition-colors hover:bg-muted hover:text-foreground", active && "text-foreground")}>
        {children}
      </button>
    </Tooltip>
  );
}

function SiblingSwitcher({ message, onSwitch }: { message: Message; onSwitch?: (id: string) => void }) {
  if (message.siblingIds.length < 2 || !onSwitch) return null;
  const i = message.siblingIds.indexOf(message.id);
  return (
    <div className="inline-flex items-center text-[12.5px] tabular-nums text-subtle-foreground">
      <button type="button" aria-label="Previous version" disabled={i <= 0} onClick={() => onSwitch(message.siblingIds[i - 1]!)} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground disabled:opacity-40">
        <ChevronLeft className="size-4" />
      </button>
      <span>
        {i + 1} / {message.siblingIds.length}
      </span>
      <button type="button" aria-label="Next version" disabled={i >= message.siblingIds.length - 1} onClick={() => onSwitch(message.siblingIds[i + 1]!)} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground disabled:opacity-40">
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

function CopyAction({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Action
      label={done ? "Copied" : "Copy"}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Action>
  );
}

export function Attachment({ file, onOpen }: { file: ChatFile; onOpen?: (f: ChatFile) => void }) {
  if (file.kind === "IMAGE" && (file.thumbUrl || file.url)) {
    return (
      <button type="button" onClick={() => onOpen?.(file)} className="overflow-hidden rounded-xl border border-border" aria-label={`Open ${file.fileName}`}>
        <img src={file.thumbUrl ?? file.url ?? ""} alt={file.fileName} className="h-28 w-auto max-w-[220px] object-cover" />
      </button>
    );
  }
  return (
    <a href={file.url ?? undefined} target="_blank" rel="noopener noreferrer" className="flex max-w-[260px] items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 text-[13px] hover:bg-muted">
      <FileText className="size-5 shrink-0 text-brand" />
      <span className="min-w-0">
        <span className="block truncate font-medium">{file.fileName}</span>
        <span className="block text-[12px] text-subtle-foreground">{file.pageCount ? `${file.pageCount} pages` : file.mimeType.split("/")[1]?.toUpperCase()}</span>
      </span>
    </a>
  );
}

export function UserMessage({ message, actions }: { message: Message; actions: MessageActions }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const long = message.content.length > 1200;
  const [expanded, setExpanded] = useState(!long);

  return (
    <div className="group flex flex-col items-end gap-2" data-testid="user-message">
      {message.attachments.length ? (
        <div className="flex flex-wrap justify-end gap-2">
          {message.attachments.map((f) => (
            <Attachment key={f.id} file={f} onOpen={actions.onOpenImage} />
          ))}
        </div>
      ) : null}
      {editing ? (
        <div className="w-full max-w-[85%] rounded-2xl bg-ground-2 p-3">
          <Textarea ref={ref} value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(10, Math.max(2, draft.split("\n").length))} className="border-0 bg-transparent p-1 shadow-none focus-visible:ring-0" />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => (setEditing(false), setDraft(message.content))}>
              Cancel
            </Button>
            <Button size="sm" disabled={!draft.trim() || draft === message.content} onClick={() => (setEditing(false), actions.onEdit?.(message, draft.trim()))}>
              Send
            </Button>
          </div>
        </div>
      ) : message.content ? (
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-ground-2 px-4 py-2.5 text-[15px] leading-[1.6]">
          {expanded ? message.content : `${message.content.slice(0, 900)}...`}
          {long ? (
            <button type="button" className="mt-1 block text-[13px] font-medium text-link" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Show more"}
            </button>
          ) : null}
        </div>
      ) : null}
      {!editing ? (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <SiblingSwitcher message={message} onSwitch={actions.onSwitch} />
          {message.content ? <CopyAction text={message.content} /> : null}
          {actions.onEdit ? (
            <Action label="Edit" onClick={() => setEditing(true)}>
              <Pencil className="size-4" />
            </Action>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const TOOL_ICON: Record<ToolStep["tool"], typeof Search> = {
  web_search: Globe,
  open_url: Link2,
  generate_image: ImageIcon,
  remember: Brain,
  search_project_files: BookOpen,
};

function Steps({ steps }: { steps: ToolStep[] }) {
  if (!steps.length) return null;
  return (
    <ul className="mb-3 space-y-1">
      {steps.map((s, i) => {
        const Icon = TOOL_ICON[s.tool] ?? Search;
        return (
          <li key={i} className={cn("flex items-center gap-2 text-[13.5px]", s.status === "FAILED" ? "text-danger" : "text-subtle-foreground")}>
            {s.status === "RUNNING" ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
            <span className={cn(s.status === "RUNNING" && "shimmer-text")}>{s.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Sources({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  if (!message.sources.length) return null;
  const shown = open ? message.sources : message.sources.slice(0, 4);
  return (
    <div className="mt-4 border-t border-border pt-3">
      <p className="mb-2 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-subtle-foreground">Sources</p>
      <ol className="space-y-1.5">
        {shown.map((s) => (
          <li key={s.n} className="flex gap-2.5 text-[13.5px]">
            <span className="w-4 shrink-0 text-right tabular-nums text-subtle-foreground">{s.n}</span>
            <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="min-w-0 hover:underline">
              <span className="font-medium">{s.title}</span> <span className="text-subtle-foreground">{s.domain}</span>
            </a>
          </li>
        ))}
      </ol>
      {message.sources.length > 4 ? (
        <button type="button" onClick={() => setOpen(!open)} className="mt-2 text-[13px] font-medium text-link">
          {open ? "Show fewer" : `Show all ${message.sources.length}`}
        </button>
      ) : null}
    </div>
  );
}

export function AssistantMessage({ message, actions, isLast }: { message: Message; actions: MessageActions; isLast: boolean }) {
  const streaming = message.status === "STREAMING";
  const failed = message.status === "FAILED";
  const thinking = streaming && !message.content && !message.toolSteps.length && !message.outputs.length;
  const reason = failed ? (actions.errorOf?.(message.id) ?? errorText(message.errorCode)) : null;
  return (
    <div className="group" data-testid="assistant-message" aria-busy={streaming}>
      <Steps steps={message.toolSteps} />
      {thinking ? (
        <div className="flex h-7 items-center gap-1.5" aria-label="Thinking">
          <span className="thinking-dot" />
          <span className="thinking-dot [animation-delay:150ms]" />
          <span className="thinking-dot [animation-delay:300ms]" />
        </div>
      ) : null}
      {message.outputs.length ? (
        <div className="mb-3 flex flex-wrap gap-3">
          {message.outputs.map((f) => (
            <button key={f.id} type="button" onClick={() => actions.onOpenImage?.(f)} className="overflow-hidden rounded-2xl border border-border" aria-label="Open image">
              <img src={f.url ?? f.thumbUrl ?? ""} alt="Generated" className="max-h-[420px] w-auto max-w-full object-contain sm:max-w-[420px]" />
            </button>
          ))}
        </div>
      ) : null}
      {message.content ? <Markdown text={message.content} sources={message.sources} className={cn(streaming && "streaming-caret")} /> : null}
      {message.status === "CANCELLED" ? <p className="mt-2 text-[13px] text-subtle-foreground">Stopped.</p> : null}
      {failed ? (
        <p className="mt-2 flex items-start gap-2 text-[14px] text-danger" role="alert">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {reason}
        </p>
      ) : null}
      {!streaming ? <Sources message={message} /> : null}
      {!streaming ? (
        <div className={cn("mt-2 flex items-center gap-0.5", !isLast && "opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100")}>
          <SiblingSwitcher message={message} onSwitch={actions.onSwitch} />
          {message.content ? <CopyAction text={message.content} /> : null}
          {actions.readAloud && message.content ? (
            <Action label={actions.speakingId === message.id ? "Stop reading" : "Read aloud"} onClick={() => void actions.onSpeak?.(message)} active={actions.speakingId === message.id}>
              {actions.speakingId === message.id ? <Square className="size-3.5" /> : <Volume2 className="size-4" />}
            </Action>
          ) : null}
          {actions.onRegenerate ? (
            <Action label="Regenerate" onClick={() => actions.onRegenerate?.(message)}>
              <RefreshCw className="size-4" />
            </Action>
          ) : null}
          {message.status === "COMPLETE" && actions.onFeedback ? (
            <>
              <Action label="Good answer" active={message.feedback === 1} onClick={() => actions.onFeedback?.(message, message.feedback === 1 ? null : 1)}>
                <ThumbsUp className={cn("size-4", message.feedback === 1 && "fill-current")} />
              </Action>
              <Action label="Bad answer" active={message.feedback === -1} onClick={() => actions.onFeedback?.(message, message.feedback === -1 ? null : -1)}>
                <ThumbsDown className={cn("size-4", message.feedback === -1 && "fill-current")} />
              </Action>
            </>
          ) : null}
          {message.model ? <span className="ml-2 text-[12px] text-subtle-foreground">{message.model.displayName}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function errorText(code: string | null): string {
  switch (code) {
    case "QUOTA_EXCEEDED":
      return "You have used today's allowance. It resets at midnight UTC.";
    case "MODEL_UNAVAILABLE":
      return "This model is not available right now. Pick another model and try again.";
    case "PROVIDER_RATE_LIMITED":
      return "The model provider is busy. Try again in a moment.";
    case "CONTEXT_TOO_LONG":
      return "This conversation is too long for the model. Start a new chat or remove some attachments.";
    case "CONTENT_BLOCKED":
      return "This request cannot be answered.";
    case "PROVIDER_ERROR":
      return "The model provider had a problem answering. Try again in a moment.";
    default:
      return "Something went wrong. Try again.";
  }
}
