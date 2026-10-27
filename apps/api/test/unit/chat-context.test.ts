/** The context builder: what a model sees for one turn. Pure, so rows are built by hand. */
import { describe, expect, test } from "vitest";
import type { LlmMessage } from "../../src/integrations/llm/types";
import type { MessageRow } from "../../src/repositories/chat.repository";
import type { FileRow } from "../../src/repositories/file.repository";
import { buildContext, IMAGE_TOKENS, TOOL_HEADROOM_TOKENS, visionMessageIds, type ContextFile } from "../../src/services/chat/context";

let n = 0;
function msg(role: "USER" | "ASSISTANT", content: string, over: Partial<MessageRow> = {}): MessageRow {
  n += 1;
  return { id: `m${n}`, conversation_id: "c1", parent_id: null, role, content, status: "COMPLETE", ...over } as unknown as MessageRow;
}

function file(kind: FileRow["kind"], name: string, over: Partial<FileRow> = {}): ContextFile {
  return { row: { id: `f-${name}`, kind, file_name: name, extracted_text: null, page_count: null, mime_type: kind === "IMAGE" ? "image/png" : "text/plain", status: "READY", ...over } as unknown as FileRow };
}

const image = (name: string) => ({ ...file("IMAGE", name), image: { data: "AAAA", mimeType: "image/png" } });

function texts(m: LlmMessage): string {
  if (m.role === "user") return m.content.map((p) => (p.type === "text" ? p.text : `[img:${p.mimeType}]`)).join("|");
  return m.content;
}

const base = { system: "SYSTEM", filesByMessage: new Map<string, ContextFile[]>(), contextWindow: 128000, maxOutputTokens: 4000, supportsVision: true, summary: null };

describe("buildContext", () => {
  test("system first, then the whole branch in order when it fits", () => {
    const path = [msg("USER", "q1"), msg("ASSISTANT", "a1"), msg("USER", "q2")];
    const out = buildContext({ ...base, path });
    expect(out.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(out.messages.map(texts)).toEqual(["SYSTEM", "q1", "a1", "q2"]);
    expect(out.dropped).toBe(0);
    expect(out.usedSummary).toBe(false);
    expect(out.estimatedTokens).toBeGreaterThan(0);
  });

  test("over budget: newest first until the budget is spent; older turns are dropped and counted", () => {
    // budget = max(2000, 6000 - 1000 - 1500) = 3500 tokens; each message is ~1000 tokens.
    const big = "x".repeat(4000);
    const path = [msg("USER", `old ${big}`), msg("ASSISTANT", `a ${big}`), msg("USER", `mid ${big}`), msg("ASSISTANT", `b ${big}`), msg("USER", "newest")];
    const out = buildContext({ ...base, path, contextWindow: 6000, maxOutputTokens: 1000 });
    const kept = out.messages.slice(1).map(texts);
    expect(kept.at(-1)).toBe("newest");
    expect(kept.some((t) => t.startsWith("old"))).toBe(false);
    expect(kept.length).toBe(4);
    expect(out.dropped).toBe(1);
    expect(out.estimatedTokens).toBeLessThanOrEqual(6000 - 1000 - TOOL_HEADROOM_TOKENS);
  });

  test("the newest message is always sent, even when it alone is over budget", () => {
    const path = [msg("USER", "earlier"), msg("ASSISTANT", "answer"), msg("USER", "y".repeat(40000))];
    const out = buildContext({ ...base, path, contextWindow: 4000, maxOutputTokens: 1000 });
    expect(out.messages).toHaveLength(2);
    expect(texts(out.messages[1]!)).toHaveLength(40000);
    expect(out.dropped).toBe(2);
  });

  test("the summary stands in only when the message it covers is on this branch", () => {
    const path = [msg("USER", "q1"), msg("ASSISTANT", "a1"), msg("USER", "q2"), msg("ASSISTANT", "a2"), msg("USER", "q3")];
    const on = buildContext({ ...base, path, summary: { text: "They talked about cats.", uptoId: path[1]!.id } });
    expect(on.usedSummary).toBe(true);
    expect(texts(on.messages[0]!)).toBe("SYSTEM\n\nSummary of the earlier part of this conversation:\nThey talked about cats.");
    expect(on.messages.slice(1).map(texts)).toEqual(["q2", "a2", "q3"]);

    const off = buildContext({ ...base, path, summary: { text: "Another branch.", uptoId: "not-on-path" } });
    expect(off.usedSummary).toBe(false);
    expect(texts(off.messages[0]!)).toBe("SYSTEM");
    expect(off.messages.slice(1).map(texts)).toEqual(["q1", "a1", "q2", "a2", "q3"]);
  });

  test("vision: image parts only on the two most recent user messages with images; older ones get a note", () => {
    const u1 = msg("USER", "first");
    const u2 = msg("USER", "second");
    const u3 = msg("USER", "third");
    const path = [u1, msg("ASSISTANT", "a"), u2, msg("ASSISTANT", "b"), u3];
    const filesByMessage = new Map<string, ContextFile[]>([
      [u1.id, [image("one.png")]],
      [u2.id, [image("two.png")]],
      [u3.id, [image("three.png")]],
    ]);
    expect([...visionMessageIds(path, filesByMessage)].sort()).toEqual([u2.id, u3.id].sort());
    const out = buildContext({ ...base, path, filesByMessage });
    const users = out.messages.filter((m) => m.role === "user") as Extract<LlmMessage, { role: "user" }>[];
    expect(users[0]!.content.some((p) => p.type === "image")).toBe(false);
    expect(texts(users[0]!)).toContain("[Image attached: one.png (not visible to you in this message)]");
    expect(users[1]!.content[0]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
    expect(users[2]!.content[0]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
  });

  test("a model without vision never gets image parts, only notes", () => {
    const u = msg("USER", "look");
    const out = buildContext({ ...base, path: [u], filesByMessage: new Map([[u.id, [image("pic.png")]]]), supportsVision: false });
    const user = out.messages[1] as Extract<LlmMessage, { role: "user" }>;
    expect(user.content.every((p) => p.type === "text")).toBe(true);
    expect(texts(user)).toBe("[Image attached: pic.png (not visible to you in this message)]\n\nlook");
  });

  test("images count IMAGE_TOKENS against the budget", () => {
    const u = msg("USER", "x");
    const withImage = buildContext({ ...base, path: [u], filesByMessage: new Map([[u.id, [image("a.png")]]]) });
    const without = buildContext({ ...base, path: [u] });
    expect(withImage.estimatedTokens - without.estimatedTokens).toBe(IMAGE_TOKENS);
  });

  test("a document on the newest message is included as text in a file block", () => {
    const u = msg("USER", "summarise it");
    const out = buildContext({ ...base, path: [u], filesByMessage: new Map([[u.id, [file("TEXT", 'notes"x".txt', { extracted_text: "Line one.\nLine two." })]]]) });
    expect(texts(out.messages[1]!)).toBe(`<file name="notes'x'.txt">\nLine one.\nLine two.\n</file>|summarise it`);
  });

  test("a document over its share of the budget is cut at a line break with a note that the rest is searchable", () => {
    const u = msg("USER", "read");
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} of the document text`).join("\n");
    const out = buildContext({ ...base, path: [u], contextWindow: 20000, maxOutputTokens: 2000, filesByMessage: new Map([[u.id, [file("PDF", "big.pdf", { extracted_text: lines })]]]) });
    const block = (out.messages[1] as Extract<LlmMessage, { role: "user" }>).content[0] as { type: "text"; text: string };
    expect(block.text.startsWith('<file name="big.pdf">\nline 0')).toBe(true);
    expect(block.text).toMatch(/\n<\/file>\n\[The rest of big\.pdf did not fit; use search_project_files to find passages in it\.\]$/);
    const body = block.text.split("\n</file>")[0]!;
    expect(body.endsWith("document text")).toBe(true);
    expect(block.text.length).toBeLessThan(lines.length);
  });

  test("documents on older messages are named only, with their page count", () => {
    const u1 = msg("USER", "here is a file");
    const u2 = msg("USER", "and now?");
    const out = buildContext({ ...base, path: [u1, msg("ASSISTANT", "ok"), u2], filesByMessage: new Map([[u1.id, [file("PDF", "report.pdf", { extracted_text: "secret body", page_count: 3 })]]]) });
    expect(texts(out.messages[1]!)).toBe("[File attached: report.pdf, 3 pages. Use search_project_files to read it.]\n\nhere is a file");
    expect(JSON.stringify(out.messages)).not.toContain("secret body");
  });

  test("assistant turns mention images they generated; a failed empty answer is marked; an empty user turn says so", () => {
    const a = msg("ASSISTANT", "Here you go.");
    const failed = msg("ASSISTANT", "", { status: "FAILED" });
    const empty = msg("USER", "");
    const out = buildContext({ ...base, path: [msg("USER", "draw"), a, msg("USER", "again"), failed, empty], filesByMessage: new Map([[a.id, [file("IMAGE", "image-1.png")]]]) });
    expect(out.messages.slice(1).map(texts)).toEqual(["draw", "Here you go.\n\n[You generated an image: image-1.png]", "again", "(this answer failed)", "(no text)"]);
  });
});
