"use client";

/**
 * Model output as Markdown: GFM (tables, task lists, strikethrough), math through KaTeX,
 * code highlighted with highlight.js, and citations as small superscript links. Raw HTML
 * in the text is never rendered (no rehype-raw), so a model cannot inject markup.
 */
import "katex/dist/katex.min.css";
import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Check, Copy } from "lucide-react";
import type { Source } from "@open-chat/types";
import { cn } from "@open-chat/ui";
import { prepareMarkdown } from "@/lib/chat/markdown";

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

function CodeBlock({ language, children }: { language: string | null; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block group/code my-4 overflow-hidden rounded-xl border border-border bg-ground-2">
      <div className="flex items-center justify-between px-4 py-1.5 text-[12px] text-subtle-foreground">
        <span className="font-mono">{language ?? "text"}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:text-foreground"
          onClick={() => {
            void navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 pb-4 text-[13px] leading-[1.6]">{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children;
    const className = (child as { props?: { className?: string } })?.props?.className ?? "";
    const language = /language-([\w-]+)/.exec(className)?.[1] ?? null;
    return <CodeBlock language={language}>{children}</CodeBlock>;
  },
  code: ({ className, children, ...rest }) => {
    const block = /language-|hljs/.test(className ?? "");
    if (block) return <code className={cn(className, "font-mono")}>{children}</code>;
    return (
      <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.88em]" {...rest}>
        {children}
      </code>
    );
  },
  a: ({ href, title, children }) => {
    if (title?.startsWith("cite:")) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="mx-0.5 align-super text-[0.7em] font-semibold text-link no-underline hover:underline" aria-label={`Source ${title.slice(5)}`}>
          {children}
        </a>
      );
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-link underline-offset-2 hover:underline">
        {children}
      </a>
    );
  },
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-[14px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border px-3 py-2 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-border/70 px-3 py-2 align-top">{children}</td>,
  img: ({ src, alt }) => (typeof src === "string" && /^https?:\/\//.test(src) ? <img src={src} alt={alt ?? ""} loading="lazy" className="my-3 max-h-96 rounded-xl" /> : null),
};

export const Markdown = memo(function Markdown({ text, sources, className }: { text: string; sources?: Source[]; className?: string }) {
  return (
    <div className={cn("chat-prose", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }], [rehypeHighlight, { detect: true, ignoreMissing: true }]]} components={components}>
        {prepareMarkdown(text, sources)}
      </ReactMarkdown>
    </div>
  );
});
