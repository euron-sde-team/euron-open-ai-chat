"use client";

/**
 * A conversation (or a new one when `conversationId` is null): the model picker and share
 * at the top, the messages in a reading column, and the composer pinned to the bottom.
 * Sending a first message moves the URL to /c/:id as soon as the server accepts it; the
 * answer keeps streaming across that navigation (lib/chat/turn-runner.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Code2, FileSearch, Lightbulb, Menu, PenLine, Share2, Upload } from "lucide-react";
import type { ChatFile, ConversationDetail, Message } from "@open-chat/types";
import { cn, toast, Tooltip } from "@open-chat/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useConversation, useModels, usePreferences } from "@/lib/chat/queries";
import { regenerate, resume, sendMessage, stop, turnState } from "@/lib/chat/turn-runner";
import { errorMessage } from "@/lib/errors";
import { useAppMeta } from "@/lib/meta";
import { qk } from "@/lib/query-keys";
import { Lightbox, type LightboxImage } from "@/components/media/lightbox";
import { NotFoundState } from "@/components/common/states";
import { Composer, type ComposerHandle, type ComposerSubmit } from "./composer";
import { AssistantMessage, UserMessage, type MessageActions } from "./message";
import { ModelPicker } from "./model-picker";
import { ShareDialog } from "./share-dialog";
import { useShell } from "./shell-context";

const SUGGESTIONS = [
  { icon: Lightbulb, text: "Explain a concept in simple terms", prompt: "Explain how vaccines train the immune system, in simple terms." },
  { icon: Code2, text: "Review a piece of code", prompt: "Review this function for bugs and readability:\n\n" },
  { icon: PenLine, text: "Draft a message", prompt: "Draft a short, friendly message asking my team for feedback on the new onboarding flow." },
  { icon: FileSearch, text: "Summarise a document", prompt: "Summarise the attached document in five bullet points." },
];

function greeting(name: string | undefined): string {
  const h = new Date().getHours();
  const part = h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name.split(" ")[0]}` : part;
}

export function ChatView({ conversationId, projectId, header, emptyTitle, emptyContent }: { conversationId: string | null; projectId?: string | null; header?: React.ReactNode; emptyTitle?: string; emptyContent?: React.ReactNode }) {
  const qc = useQueryClient();
  const router = useRouter();
  const { user } = useAuth();
  const shell = useShell();
  const meta = useAppMeta();
  const models = useModels();
  const prefs = usePreferences();
  const convo = useConversation(conversationId);
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [lightbox, setLightbox] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const activeTurn = useSyncExternalStore(turnState.subscribe, () => turnState.activeIn(conversationId), () => null);
  const detail: ConversationDetail | undefined = convo.data;
  const messages = useMemo(() => detail?.messages ?? [], [detail]);
  const streaming = !!activeTurn || messages.some((m) => m.status === "STREAMING");

  // The model: what the user picked here, else the one that answered last, else their default, else the deployment's.
  const chatModels = models.data?.chat ?? [];
  const lastModel = [...messages].reverse().find((m) => m.role === "ASSISTANT" && m.model)?.model?.id;
  const effectiveModel = modelId ?? (lastModel && chatModels.some((m) => m.id === lastModel) ? lastModel : null) ?? prefs.data?.defaultModelId ?? chatModels.find((m) => m.isDefault)?.id ?? chatModels[0]?.id ?? null;

  useEffect(() => {
    if (detail?.activeTurnId && !turnState.isRunning(detail.activeTurnId)) resume(qc, detail);
  }, [detail, qc]);

  // Follow the answer while the reader is at the bottom; stop following once they scroll up.
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stickToBottom.current = near;
    setShowJump(!near);
  };
  const lastContentLength = messages.at(-1)?.content.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastContentLength, messages.at(-1)?.toolSteps.length]);
  useEffect(() => {
    stickToBottom.current = true;
    const el = scroller.current;
    if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
  }, [conversationId]);

  const send = useCallback(
    async (input: ComposerSubmit & { parentId?: string | null }) => {
      stickToBottom.current = true;
      try {
        await sendMessage(qc, {
          conversationId,
          projectId: projectId ?? null,
          content: input.content,
          files: input.files,
          fileIds: input.files.map((f) => f.id),
          modelId: effectiveModel ?? undefined,
          webSearch: input.webSearch,
          mode: input.mode,
          aspectRatio: input.aspectRatio,
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          onStarted: (id) => {
            if (!conversationId) router.replace(`/c/${id}`);
          },
        });
      } catch (err) {
        toast.error({ title: errorMessage(err) });
      }
    },
    [qc, conversationId, projectId, effectiveModel, router],
  );

  const actions: MessageActions = {
    readAloud: !!meta.data?.features.readAloud,
    speakingId,
    errorOf: turnState.errorOf,
    onEdit: (m, content) => void send({ content, files: m.attachments, webSearch: m.webSearch, mode: "chat", aspectRatio: "1:1", parentId: m.parentId }),
    onRegenerate: (m) => {
      if (!conversationId || streaming) return;
      stickToBottom.current = true;
      regenerate(qc, conversationId, m, { modelId: effectiveModel ?? undefined }).catch((err) => toast.error({ title: errorMessage(err) }));
    },
    onSwitch: (id) => {
      if (!conversationId) return;
      api()
        .chats.setLeaf(conversationId, id)
        .then((d) => qc.setQueryData(qk.chat(conversationId), d))
        .catch((err) => toast.error({ title: errorMessage(err) }));
    },
    onFeedback: (m, value) => {
      if (!conversationId) return;
      qc.setQueryData<ConversationDetail>(qk.chat(conversationId), (d) => (d ? { ...d, messages: d.messages.map((x) => (x.id === m.id ? { ...x, feedback: value } : x)) } : d));
      api()
        .messages.feedback(m.id, value)
        .then(() => value === -1 && toast.info({ title: "Thanks for the feedback" }))
        .catch(() => undefined);
    },
    onSpeak: async (m: Message) => {
      if (speakingId === m.id) {
        audio.current?.pause();
        setSpeakingId(null);
        return;
      }
      audio.current?.pause();
      setSpeakingId(m.id);
      try {
        const blob = await api().messages.speech(m.id);
        const url = URL.createObjectURL(blob);
        const a = new Audio(url);
        audio.current = a;
        a.onended = () => (setSpeakingId(null), URL.revokeObjectURL(url));
        await a.play();
      } catch (err) {
        setSpeakingId(null);
        toast.error({ title: errorMessage(err) });
      }
    },
    onOpenImage: (file: ChatFile) => {
      const all = messages.flatMap((m) => [...m.attachments, ...m.outputs]).filter((f) => f.kind === "IMAGE");
      const index = Math.max(0, all.findIndex((f) => f.id === file.id));
      setLightbox({ images: all.map((f) => ({ file: f })), index });
    },
  };

  const features = meta.data?.features;
  const limits = meta.data?.limits;
  const empty = !conversationId || (!convo.isLoading && messages.length === 0);
  const noModels = models.isSuccess && chatModels.length === 0;
  const composerEl = (
    <Composer
      ref={composer}
      size={empty ? "large" : "normal"}
      autoFocus
      streaming={streaming}
      onStop={() => activeTurn && void stop(activeTurn)}
      onSubmit={(input) => void send(input)}
      disabledReason={noModels ? "No model is configured yet. An admin can add one in Admin, Models." : user?.status === "SUSPENDED" ? "Your account is restricted: you can read but not send." : null}
      features={{ webSearch: !!features?.webSearch, imageGeneration: !!features?.imageGeneration, dictation: !!features?.dictation }}
      webSearchDefault={prefs.data?.webSearchDefault ?? true}
      acceptedMimeTypes={limits?.acceptedMimeTypes ?? []}
      maxFiles={limits?.maxFilesPerMessage ?? 10}
      maxChars={limits?.maxMessageChars ?? 32000}
    />
  );

  if (conversationId && convo.isError) return <NotFoundState title="This chat is not available" description="It may have been deleted." />;

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        composer.current?.addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-1 px-2 sm:px-3">
        {shell.collapsed || shell.mobile ? (
          <Tooltip content="Open sidebar">
            <button type="button" aria-label="Open sidebar" onClick={shell.open} className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
              <Menu className="size-5" />
            </button>
          </Tooltip>
        ) : null}
        <ModelPicker models={chatModels} value={effectiveModel} onChange={setModelId} />
        <div className="ml-auto flex items-center gap-1">
          {header}
          {conversationId && messages.some((m) => m.role === "ASSISTANT" && m.status === "COMPLETE") && features?.sharing ? (
            <button type="button" onClick={() => setSharing(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[14px] font-medium hover:bg-muted">
              <Share2 className="size-4" /> Share
            </button>
          ) : null}
        </div>
      </header>

      {empty ? (
        <div className={cn("flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4", emptyContent ? "pt-[10vh] pb-10" : "justify-center pb-[8vh]")}>
          <h1 className="mb-7 text-balance text-center font-display text-[30px] font-semibold tracking-[-0.02em] sm:text-[36px]">{emptyTitle ?? greeting(user?.displayName)}</h1>
          <div className="w-full max-w-[760px]">{composerEl}</div>
          {emptyContent ?? (
          <ul className="mt-6 grid w-full max-w-[760px] gap-x-6 sm:grid-cols-2">
            {SUGGESTIONS.map((s) => (
              <li key={s.text}>
                <button type="button" onClick={() => composer.current?.setText(s.prompt)} className="flex w-full items-center gap-3 border-b border-border py-3 text-left text-[14.5px] text-muted-foreground transition-colors hover:text-foreground">
                  <s.icon className="size-4 shrink-0 text-brand" />
                  {s.text}
                </button>
              </li>
            ))}
          </ul>
          )}
        </div>
      ) : (
        <>
          <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[780px] space-y-8 px-4 pb-8 pt-4 sm:px-6">
              {convo.isLoading
                ? Array.from({ length: 3 }, (_, i) => (
                    <div key={i} className="space-y-3">
                      <div className="ml-auto h-10 w-2/5 animate-pulse rounded-2xl bg-muted" />
                      <div className="h-4 w-11/12 animate-pulse rounded bg-muted" />
                      <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
                    </div>
                  ))
                : messages.map((m, i) =>
                    m.role === "USER" ? (
                      <UserMessage key={m.id} message={m} actions={{ ...actions, onEdit: streaming ? undefined : actions.onEdit }} />
                    ) : (
                      <AssistantMessage key={m.id} message={m} isLast={i === messages.length - 1} actions={{ ...actions, onRegenerate: streaming ? undefined : actions.onRegenerate }} />
                    ),
                  )}
            </div>
          </div>
          <div className="relative shrink-0 px-3 pb-3 sm:px-6">
            {showJump ? (
              <button type="button" aria-label="Scroll to the latest message" onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" })} className="absolute -top-12 left-1/2 inline-flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card shadow-sm hover:bg-muted">
                <ArrowDown className="size-4" />
              </button>
            ) : null}
            <div className="mx-auto w-full max-w-[780px]">{composerEl}</div>
            <p className="mt-2 text-center text-[12px] text-subtle-foreground">Answers can be wrong. Check what matters.</p>
          </div>
        </>
      )}

      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-brand bg-background/85 text-[15px] font-medium">
          <Upload className="size-6 text-brand" />
          Drop files to attach them
        </div>
      ) : null}
      {lightbox ? <Lightbox images={lightbox.images} index={lightbox.index} onIndex={(i) => setLightbox({ ...lightbox, index: i })} onClose={() => setLightbox(null)} /> : null}
      {conversationId && sharing ? <ShareDialog conversationId={conversationId} title={detail?.title ?? "Chat"} open onOpenChange={setSharing} /> : null}
      <span className={cn("sr-only")} aria-live="polite">
        {streaming ? "The assistant is writing" : ""}
      </span>
    </div>
  );
}
