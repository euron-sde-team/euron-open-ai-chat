"use client";

/** Full-screen image viewer: arrow keys move, Escape closes, download keeps the original. */
import { useEffect } from "react";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import type { ChatFile } from "@open-chat/types";

export interface LightboxImage {
  file: ChatFile;
  caption?: string;
}

export function Lightbox({ images, index, onIndex, onClose, actions }: { images: LightboxImage[]; index: number; onIndex: (i: number) => void; onClose: () => void; actions?: React.ReactNode }) {
  const current = images[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && index < images.length - 1) onIndex(index + 1);
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [index, images.length, onIndex, onClose]);
  if (!current) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Image" className="fixed inset-0 z-[90] flex flex-col bg-[hsl(var(--overlay)/0.92)] text-white" onClick={onClose}>
      <div className="flex items-center justify-end gap-1 p-3" onClick={(e) => e.stopPropagation()}>
        {actions}
        {current.file.url ? (
          <a href={current.file.url} download={current.file.fileName} className="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/10" aria-label="Download">
            <Download className="size-5" />
          </a>
        ) : null}
        <button type="button" onClick={onClose} className="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/10" aria-label="Close">
          <X className="size-5" />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
        {index > 0 ? (
          <button type="button" aria-label="Previous" onClick={(e) => (e.stopPropagation(), onIndex(index - 1))} className="absolute left-3 inline-flex size-11 items-center justify-center rounded-full hover:bg-white/10">
            <ChevronLeft className="size-6" />
          </button>
        ) : null}
        <img src={current.file.url ?? current.file.thumbUrl ?? ""} alt={current.caption ?? current.file.fileName} className="max-h-full max-w-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
        {index < images.length - 1 ? (
          <button type="button" aria-label="Next" onClick={(e) => (e.stopPropagation(), onIndex(index + 1))} className="absolute right-3 inline-flex size-11 items-center justify-center rounded-full hover:bg-white/10">
            <ChevronRight className="size-6" />
          </button>
        ) : null}
      </div>
      {current.caption ? (
        <p className="mx-auto max-w-2xl px-6 pb-6 text-center text-[14px] text-white/80" onClick={(e) => e.stopPropagation()}>
          {current.caption}
        </p>
      ) : null}
    </div>
  );
}
