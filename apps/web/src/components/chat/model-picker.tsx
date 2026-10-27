"use client";

/** Which model answers. Shows each model's description and what it can do; remembers nothing itself (the caller owns the choice). */
import { Check, ChevronDown, Eye, Globe, Sparkles } from "lucide-react";
import type { ChatModel } from "@open-chat/types";
import { cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@open-chat/ui";

export function ModelPicker({ models, value, onChange, className }: { models: ChatModel[]; value: string | null; onChange: (id: string) => void; className?: string }) {
  const current = models.find((m) => m.id === value) ?? models.find((m) => m.isDefault) ?? models[0];
  if (!current) return <span className="text-[14px] text-subtle-foreground">No models configured</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn("inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 font-display text-[16px] font-semibold tracking-[-0.01em] hover:bg-muted", className)} aria-label={`Model: ${current.displayName}`}>
          {current.displayName}
          <ChevronDown className="size-4 text-subtle-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[320px] p-1.5">
        <DropdownMenuLabel className="px-2 pb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle-foreground">Model</DropdownMenuLabel>
        {models.map((m) => (
          <DropdownMenuItem key={m.id} onSelect={() => onChange(m.id)} className="items-start gap-3 rounded-lg px-2 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[14px] font-semibold">
                {m.displayName}
                <span className="flex items-center gap-1 text-subtle-foreground">
                  {m.supportsVision ? <Eye className="size-3.5" aria-label="Sees images" /> : null}
                  {m.supportsTools ? <Globe className="size-3.5" aria-label="Uses tools" /> : null}
                  {m.supportsReasoning ? <Sparkles className="size-3.5" aria-label="Reasons" /> : null}
                </span>
              </div>
              <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">{m.description || m.provider}</p>
            </div>
            {m.id === current.id ? <Check className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
