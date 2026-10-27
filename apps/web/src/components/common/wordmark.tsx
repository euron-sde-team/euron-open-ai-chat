"use client";

import Link from "next/link";
import { cn } from "@open-chat/ui";
import { useProductName } from "@/lib/meta";

/** Split for the two-tone wordmark: all but the last word strong, the last word muted. */
export function splitName(name: string): { lead: string; tail: string } {
  const t = name.trim();
  const i = t.lastIndexOf(" ");
  return i < 0 ? { lead: t, tail: "" } : { lead: t.slice(0, i), tail: t.slice(i + 1) };
}

export function LogoMark({ className }: { className?: string }) {
  // A speech bubble with a spark: a conversation that thinks.
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-8 shrink-0", className)}>
      <rect width="32" height="32" rx="9" className="fill-ink" />
      <path d="M8 10.5A3.5 3.5 0 0 1 11.5 7h9A3.5 3.5 0 0 1 24 10.5v6.5a3.5 3.5 0 0 1-3.5 3.5h-5.2L11 24.2v-3.7A3.5 3.5 0 0 1 8 17z" fill="white" fillOpacity="0.94" />
      <path d="M16 9.6l1.05 2.35 2.35 1.05-2.35 1.05L16 16.4l-1.05-2.35L12.6 13l2.35-1.05z" className="fill-brand" />
    </svg>
  );
}

export function Wordmark({ compact, className, textClassName }: { compact?: boolean; className?: string; textClassName?: string }) {
  const name = useProductName();
  const { lead, tail } = splitName(name);
  return (
    <Link href="/" className={cn("flex min-w-0 items-center gap-2 rounded-md focus-visible:ring-2", className)} aria-label={`${name} home`}>
      <LogoMark />
      {compact ? null : (
        <span className={cn("truncate font-display text-[17px] font-semibold tracking-[-0.02em] text-foreground", textClassName)}>
          {lead}
          {tail ? <span className="font-semibold text-muted-foreground"> {tail}</span> : null}
        </span>
      )}
    </Link>
  );
}
