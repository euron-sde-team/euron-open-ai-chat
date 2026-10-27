/**
 * Preparing model output for the Markdown renderer. Pure, so it is unit-tested.
 *
 *   - LaTeX in \[ \] and \( \) (what most models write) becomes $$ $$ and $ $, which
 *     remark-math understands;
 *   - citations [n] become links to source n (rendered as small superscripts);
 *   - code (fenced blocks and inline code) is left exactly as written.
 */
import type { Source } from "@open-chat/types";

/** Split into code and prose parts so transforms never touch code. */
function splitCode(text: string): { code: boolean; text: string }[] {
  const parts: { code: boolean; text: string }[] = [];
  const re = /(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parts.push({ code: false, text: text.slice(last, m.index) });
    parts.push({ code: true, text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}

export function normaliseMath(text: string): string {
  return text.replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner: string) => `$$${inner}$$`).replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner: string) => `$${inner}$`);
}

/** [n] with a known source becomes [n](url "cite:n"); unknown numbers are left alone. */
export function linkCitations(text: string, sources: Source[]): string {
  if (!sources.length) return text;
  const byN = new Map(sources.map((s) => [s.n, s]));
  return text.replace(/\[(\d{1,2})\](?![(:])/g, (m, n: string) => {
    const s = byN.get(Number(n));
    return s ? `[${n}](${s.url} "cite:${n}")` : m;
  });
}

export function prepareMarkdown(text: string, sources: Source[] = []): string {
  return splitCode(text)
    .map((p) => (p.code ? p.text : linkCitations(normaliseMath(p.text), sources)))
    .join("");
}
