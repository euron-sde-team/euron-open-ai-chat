/**
 * Text helpers for documents: cleaning extracted text, estimating tokens without a
 * tokenizer, and cutting text into overlapping passages for project search. Pure.
 */

/** Rough token count (about 4 characters per token in English prose and code). Good enough for budgets. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Normalise whitespace and strip control characters that PDF extraction leaves behind. */
export function cleanExtracted(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Keep the first `max` characters, cut at a line break when one is close. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", max);
  return { text: text.slice(0, cut > max * 0.9 ? cut : max), truncated: true };
}

export const CHUNK_CHARS = 1600;
export const CHUNK_OVERLAP = 200;

/**
 * Passages of about CHUNK_CHARS characters, cut at paragraph or sentence ends where
 * possible, each overlapping the previous by CHUNK_OVERLAP so an answer that straddles a
 * boundary is still found whole in one of them.
 */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const para = window.lastIndexOf("\n\n");
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"), window.lastIndexOf("? "), window.lastIndexOf("! "));
      const brk = para > size * 0.5 ? para : sentence > size * 0.5 ? sentence + 1 : -1;
      if (brk > 0) end = start + brk;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}
