"use client";

/** The image studio and gallery: describe an image, pick a shape, and every picture you made, newest first. */
import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Menu, Pencil, Trash2 } from "lucide-react";
import type { AspectRatio, GeneratedImage } from "@open-chat/types";
import { ASPECT_RATIOS } from "@open-chat/types";
import { Button, cn, Textarea, toast, Tooltip } from "@open-chat/ui";
import { Lightbox } from "@/components/media/lightbox";
import { api } from "@/lib/api";
import { useUsage } from "@/lib/chat/queries";
import { errorMessage } from "@/lib/errors";
import { useAppMeta } from "@/lib/meta";
import { qk } from "@/lib/query-keys";
import { useShell } from "./shell-context";

export function ImagesView() {
  const qc = useQueryClient();
  const shell = useShell();
  const meta = useAppMeta();
  const usage = useUsage();
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<AspectRatio>("1:1");
  const [editing, setEditing] = useState<GeneratedImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const gallery = useInfiniteQuery({
    queryKey: qk.images,
    queryFn: ({ pageParam }) => api().images.list({ cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const items = gallery.data?.pages.flatMap((p) => p.items) ?? [];
  const enabled = meta.data?.features.imageGeneration;

  const generate = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      await api().images.create({ prompt: prompt.trim(), aspectRatio: ratio, sourceImageId: editing?.id });
      setPrompt("");
      setEditing(null);
      await Promise.all([qc.invalidateQueries({ queryKey: qk.images }), qc.invalidateQueries({ queryKey: qk.usage })]);
    } catch (err) {
      toast.error({ title: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex h-14 items-center gap-1 px-2 sm:px-3">
        {shell.collapsed || shell.mobile ? (
          <button type="button" aria-label="Open sidebar" onClick={shell.open} className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted">
            <Menu className="size-5" />
          </button>
        ) : null}
        <h1 className="px-2 font-display text-[16px] font-semibold">Images</h1>
      </header>
      <div className="mx-auto w-full max-w-[1100px] px-4 pb-16 sm:px-6">
        <div className="mx-auto max-w-[760px] pt-4">
          {editing ? (
            <div className="mb-3 flex items-center gap-3 text-[13.5px] text-muted-foreground">
              <img src={editing.file.thumbUrl ?? editing.file.url ?? ""} alt="" className="size-12 rounded-lg object-cover" />
              <span className="min-w-0 flex-1">Editing this image. Describe what to change.</span>
              <button type="button" className="font-medium text-link" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          ) : null}
          <div className="rounded-[22px] border border-input bg-card p-2 focus-within:border-ring/60">
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} maxLength={4000} disabled={!enabled} placeholder={enabled ? "A lighthouse at dusk, flat illustration, warm sky" : "Image generation is turned off"} className="border-0 bg-transparent text-[15px] shadow-none focus-visible:ring-0" onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void generate()} />
            <div className="flex flex-wrap items-center gap-1 px-1">
              {ASPECT_RATIOS.map((r) => (
                <button key={r} type="button" aria-pressed={ratio === r} onClick={() => setRatio(r)} className={cn("h-8 rounded-lg px-2.5 text-[13px] tabular-nums", ratio === r ? "font-semibold text-foreground" : "text-subtle-foreground hover:text-foreground")}>
                  {r}
                </button>
              ))}
              <div className="ml-auto flex items-center gap-3">
                {usage.data?.images.limit != null ? <span className="text-[12.5px] tabular-nums text-subtle-foreground">{Math.max(0, usage.data.images.limit - usage.data.images.used)} left today</span> : null}
                <Button onClick={() => void generate()} loading={busy} disabled={!enabled || !prompt.trim()}>
                  {editing ? "Edit image" : "Create"}
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-10 columns-2 gap-3 sm:columns-3 lg:columns-4">
          {busy ? (
            <div className="mb-3 flex aspect-square break-inside-avoid items-center justify-center rounded-2xl bg-muted">
              <Loader2 className="size-6 animate-spin text-subtle-foreground" />
            </div>
          ) : null}
          {items.map((img, i) => (
            <figure key={img.id} className="group relative mb-3 break-inside-avoid overflow-hidden rounded-2xl">
              <button type="button" className="block w-full" onClick={() => setOpen(i)} aria-label={`Open: ${img.prompt}`}>
                <img src={img.file.thumbUrl ?? img.file.url ?? ""} alt={img.prompt} loading="lazy" className="w-full" />
              </button>
              <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3 text-[12.5px] text-white opacity-0 transition-opacity group-hover:opacity-100">{img.prompt}</figcaption>
            </figure>
          ))}
        </div>
        {!gallery.isLoading && !items.length ? <p className="mt-6 text-center text-[14px] text-subtle-foreground">Images you create, here or in a chat, will appear here.</p> : null}
        {gallery.hasNextPage ? (
          <div className="mt-6 text-center">
            <Button variant="ghost" onClick={() => void gallery.fetchNextPage()} loading={gallery.isFetchingNextPage}>
              Show more
            </Button>
          </div>
        ) : null}
      </div>
      {open !== null && items[open] ? (
        <Lightbox
          images={items.map((i) => ({ file: i.file, caption: i.prompt }))}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          actions={
            <>
              <Tooltip content="Edit">
                <button type="button" aria-label="Edit" className="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/10" onClick={() => (setEditing(items[open]!), setOpen(null), window.scrollTo({ top: 0, behavior: "smooth" }))}>
                  <Pencil className="size-5" />
                </button>
              </Tooltip>
              <Tooltip content="Remove from gallery">
                <button type="button" aria-label="Remove from gallery" className="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/10" onClick={() => void api().images.remove(items[open]!.id).then(() => (setOpen(null), qc.invalidateQueries({ queryKey: qk.images })))}>
                  <Trash2 className="size-5" />
                </button>
              </Tooltip>
            </>
          }
        />
      ) : null}
    </div>
  );
}
