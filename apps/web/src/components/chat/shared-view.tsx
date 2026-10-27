"use client";

/** The public page of a shared chat: read only, no account needed. */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { Button } from "@open-chat/ui";
import { LogoMark } from "@/components/common/wordmark";
import { NotFoundState } from "@/components/common/states";
import { api } from "@/lib/api";
import { useProductName } from "@/lib/meta";
import { qk } from "@/lib/query-keys";
import { Markdown } from "./markdown";

export function SharedView({ id }: { id: string }) {
  const name = useProductName();
  const q = useQuery({ queryKey: qk.shared(id), queryFn: ({ signal }) => api().shared.get(id, signal), retry: false });
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6">
        <Link href="/" className="flex items-center gap-2">
          <LogoMark className="size-7" />
          <span className="font-display text-[15px] font-semibold">{name}</span>
        </Link>
        <Button asChild size="sm">
          <Link href="/">Start your own chat</Link>
        </Button>
      </header>
      {q.isError ? (
        <NotFoundState title="This link does not exist or was removed" />
      ) : (
        <main className="mx-auto w-full max-w-[760px] px-4 pb-24 pt-10 sm:px-6">
          {q.data ? (
            <>
              <h1 className="font-display text-[28px] font-semibold tracking-[-0.02em]">{q.data.title}</h1>
              <p className="mt-1 text-[13.5px] text-subtle-foreground">
                Shared by {q.data.sharedBy} on {new Date(q.data.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}
              </p>
              <div className="mt-10 space-y-8">
                {q.data.messages.map((m) =>
                  m.role === "USER" ? (
                    <div key={m.id} className="flex flex-col items-end gap-2">
                      {m.images.map((img) => (
                        <img key={img.url} src={img.url} alt="" className="h-28 rounded-xl border border-border" />
                      ))}
                      {m.attachmentNames.map((n) => (
                        <span key={n} className="flex items-center gap-1.5 text-[13px] text-subtle-foreground">
                          <FileText className="size-4" /> {n}
                        </span>
                      ))}
                      {m.content ? <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-ground-2 px-4 py-2.5 text-[15px] leading-[1.6]">{m.content}</div> : null}
                    </div>
                  ) : (
                    <div key={m.id}>
                      {m.images.length ? (
                        <div className="mb-3 flex flex-wrap gap-3">
                          {m.images.map((img) => (
                            <img key={img.url} src={img.url} alt="Generated" className="max-h-[420px] rounded-2xl border border-border" />
                          ))}
                        </div>
                      ) : null}
                      <Markdown text={m.content} sources={m.sources} />
                      {m.model ? <p className="mt-2 text-[12px] text-subtle-foreground">{m.model}</p> : null}
                    </div>
                  ),
                )}
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div className="h-8 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
            </div>
          )}
        </main>
      )}
    </div>
  );
}
