"use client";

/**
 * The composer. Files are uploaded the moment they are picked, pasted or dropped (with
 * progress), so sending is instant. Enter sends, Shift+Enter is a new line. The row under
 * the text holds the actions: attach, web search on or off, image mode, dictation, and
 * send (which becomes stop while an answer is being written).
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowUp, FileText, Globe, Image as ImageIcon, Loader2, Mic, Paperclip, Plus, Square, X } from "lucide-react";
import type { AspectRatio, ChatFile } from "@open-chat/types";
import { ASPECT_RATIOS } from "@open-chat/types";
import { cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, toast, Tooltip } from "@open-chat/ui";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

export interface ComposerSubmit {
  content: string;
  files: ChatFile[];
  webSearch: boolean;
  mode: "chat" | "image";
  aspectRatio: AspectRatio;
}

interface Pending {
  key: string;
  name: string;
  isImage: boolean;
  preview: string | null;
  progress: number;
  file: ChatFile | null;
  error: string | null;
}

export interface ComposerHandle {
  addFiles: (files: File[]) => void;
  setText: (text: string) => void;
  focus: () => void;
}

interface Props {
  onSubmit: (input: ComposerSubmit) => void;
  onStop?: () => void;
  streaming: boolean;
  disabledReason?: string | null;
  placeholder?: string;
  features: { webSearch: boolean; imageGeneration: boolean; dictation: boolean };
  webSearchDefault: boolean;
  acceptedMimeTypes: string[];
  maxFiles: number;
  maxChars: number;
  autoFocus?: boolean;
  size?: "large" | "normal";
}

let keySeq = 0;

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(props, ref) {
  const { onSubmit, onStop, streaming, disabledReason, features, webSearchDefault, acceptedMimeTypes, maxFiles, maxChars } = props;
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [webSearch, setWebSearch] = useState(webSearchDefault);
  const [mode, setMode] = useState<"chat" | "image">("chat");
  const [ratio, setRatio] = useState<AspectRatio>("1:1");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setWebSearch(webSearchDefault), [webSearchDefault]);

  const resize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
  };
  useEffect(resize, [text]);

  const addFiles = useCallback(
    (files: File[]) => {
      const room = maxFiles - pending.length;
      if (files.length > room) toast.info({ title: `You can attach up to ${maxFiles} files` });
      for (const f of files.slice(0, Math.max(0, room))) {
        const key = `p${++keySeq}`;
        const isImage = f.type.startsWith("image/");
        setPending((p) => [...p, { key, name: f.name, isImage, preview: isImage ? URL.createObjectURL(f) : null, progress: 0, file: null, error: null }]);
        api()
          .files.upload({ purpose: "ATTACHMENT", file: f, onProgress: (x) => setPending((p) => p.map((it) => (it.key === key ? { ...it, progress: x } : it))) })
          .then((file) => setPending((p) => p.map((it) => (it.key === key ? { ...it, file, progress: 1 } : it))))
          .catch((err) => setPending((p) => p.map((it) => (it.key === key ? { ...it, error: errorMessage(err) } : it))));
      }
    },
    [maxFiles, pending.length],
  );

  useImperativeHandle(ref, () => ({ addFiles, setText: (t) => (setText(t), taRef.current?.focus()), focus: () => taRef.current?.focus() }), [addFiles]);

  const uploading = pending.some((p) => !p.file && !p.error);
  const ready = pending.filter((p) => p.file).map((p) => p.file!);
  const canSend = !streaming && !uploading && !disabledReason && (text.trim().length > 0 || (mode === "chat" && ready.length > 0)) && text.length <= maxChars;

  const submit = () => {
    if (!canSend) return;
    onSubmit({ content: text.trim(), files: ready, webSearch, mode, aspectRatio: ratio });
    setText("");
    for (const p of pending) if (p.preview) URL.revokeObjectURL(p.preview);
    setPending([]);
    setMode("chat");
  };

  return (
    <div className={cn("relative w-full rounded-[22px] border border-input bg-card shadow-[0_8px_30px_-18px_hsl(var(--overlay)/0.35)] transition-shadow focus-within:border-ring/60", props.size === "large" && "rounded-[26px]")}>
      {pending.length ? (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {pending.map((p) => (
            <div key={p.key} className={cn("group relative flex items-center gap-2 overflow-hidden rounded-xl border border-border bg-ground-2 text-[13px]", p.isImage ? "size-16" : "h-12 max-w-[220px] px-3")} title={p.error ?? p.name}>
              {p.isImage && p.preview ? <img src={p.preview} alt="" className="size-full object-cover" /> : <FileText className="size-4 shrink-0 text-brand" />}
              {!p.isImage ? <span className="truncate">{p.name}</span> : null}
              {!p.file && !p.error ? (
                <span className="absolute inset-0 flex items-center justify-center bg-background/60 text-[11px] font-semibold tabular-nums">{p.progress < 1 ? `${Math.round(p.progress * 100)}%` : <Loader2 className="size-4 animate-spin" />}</span>
              ) : null}
              {p.error ? <span className="absolute inset-0 flex items-center justify-center bg-danger/80 px-1 text-center text-[10.5px] font-semibold text-danger-foreground">Failed</span> : null}
              <button type="button" aria-label={`Remove ${p.name}`} onClick={() => setPending((list) => list.filter((it) => it.key !== p.key))} className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded-full bg-ink text-ink-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100">
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <textarea
        ref={taRef}
        value={text}
        rows={1}
        autoFocus={props.autoFocus}
        aria-label="Message"
        placeholder={disabledReason ?? (mode === "image" ? "Describe the image you want" : (props.placeholder ?? "Ask anything"))}
        disabled={!!disabledReason}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        className={cn("block w-full resize-none bg-transparent px-4 pt-3.5 composer-input outline-none text-[15.5px] leading-[1.55] outline-none placeholder:text-subtle-foreground disabled:cursor-not-allowed", props.size === "large" ? "min-h-[64px]" : "min-h-[52px]")}
      />
      <div className="flex items-center gap-1 px-2 pb-2 pt-1">
        <input ref={fileRef} type="file" multiple hidden accept={acceptedMimeTypes.join(",")} onChange={(e) => (addFiles(Array.from(e.target.files ?? [])), (e.target.value = ""))} />
        <DropdownMenu>
          <Tooltip content="Add">
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Add files and more" className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
                <Plus className="size-5" />
              </button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
              <Paperclip className="size-4" /> Add photos and files
            </DropdownMenuItem>
            {features.imageGeneration ? (
              <DropdownMenuItem onSelect={() => setMode("image")}>
                <ImageIcon className="size-4" /> Create an image
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {features.webSearch && mode === "chat" ? (
          <button type="button" aria-pressed={webSearch} onClick={() => setWebSearch(!webSearch)} className={cn("inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13.5px] font-medium transition-colors", webSearch ? "text-primary hover:bg-primary-soft" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
            <Globe className="size-4" />
            Search
          </button>
        ) : null}
        {mode === "image" ? (
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setMode("chat")} className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13.5px] font-medium text-primary hover:bg-primary-soft">
              <ImageIcon className="size-4" />
              Image
              <X className="size-3.5" />
            </button>
            <select aria-label="Aspect ratio" value={ratio} onChange={(e) => setRatio(e.target.value as AspectRatio)} className="h-9 rounded-lg bg-transparent px-2 text-[13px] text-muted-foreground hover:bg-muted focus:outline-none">
              {ASPECT_RATIOS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {text.length > maxChars * 0.8 ? <span className={cn("mr-1 text-[12px] tabular-nums", text.length > maxChars ? "text-danger" : "text-subtle-foreground")}>{text.length.toLocaleString()} / {maxChars.toLocaleString()}</span> : null}
          {features.dictation ? <DictationButton onText={(t) => setText((cur) => (cur ? `${cur.trimEnd()} ${t}` : t))} disabled={!!disabledReason} /> : null}
          {streaming ? (
            <Tooltip content="Stop">
              <button type="button" aria-label="Stop" onClick={onStop} className="inline-flex size-9 items-center justify-center rounded-full bg-ink text-ink-foreground hover:opacity-90">
                <Square className="size-3.5 fill-current" />
              </button>
            </Tooltip>
          ) : (
            <Tooltip content="Send">
              <button type="button" aria-label="Send" onClick={submit} disabled={!canSend} className="inline-flex size-9 items-center justify-center rounded-full bg-ink text-ink-foreground transition-opacity hover:opacity-90 disabled:opacity-25">
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-[18px]" />}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
});

/** Hold the mic to speak; the transcript is added to the message. */
function DictationButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: (rec.mimeType || "audio/webm").split(";")[0] });
        setState("transcribing");
        try {
          const { text } = await api().speech.transcribe(blob);
          if (text) onText(text);
          else toast.info({ title: "Nothing was heard" });
        } catch (err) {
          toast.error({ title: errorMessage(err) });
        } finally {
          setState("idle");
        }
      };
      recorder.current = rec;
      rec.start();
      setState("recording");
      // A minute at most per dictation.
      setTimeout(() => rec.state === "recording" && rec.stop(), 60_000);
    } catch {
      toast.error({ title: "The microphone is not available", description: "Allow microphone access in your browser to dictate." });
    }
  };

  const label = state === "recording" ? "Stop dictation" : state === "transcribing" ? "Transcribing" : "Dictate";
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled || state === "transcribing"}
        onClick={() => (state === "recording" ? recorder.current?.stop() : void start())}
        className={cn("inline-flex size-9 items-center justify-center rounded-full transition-colors disabled:opacity-40", state === "recording" ? "bg-danger text-danger-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
      >
        {state === "transcribing" ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-[18px]" />}
      </button>
    </Tooltip>
  );
}
