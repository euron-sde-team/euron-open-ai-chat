import { describe, expect, test } from "vitest";
import { capText, CHUNK_CHARS, CHUNK_OVERLAP, chunkText, cleanExtracted, estimateTokens } from "../../src/domain/chunking";

describe("estimateTokens", () => {
  test("about four characters per token, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(4000))).toBe(1000);
  });
});

describe("cleanExtracted", () => {
  test("strips control characters but keeps tabs and newlines", () => {
    expect(cleanExtracted("a\u0000b\u0007c\u000bd\u007fe\tf\ng")).toBe("abcde\tf\ng");
  });

  test("normalises line endings, trailing spaces and runs of blank lines, then trims", () => {
    expect(cleanExtracted("  one  \r\ntwo\t\r\rthree\n\n\n\n\nfour  ")).toBe("one\ntwo\n\nthree\n\nfour");
  });
});

describe("capText", () => {
  test("short text is untouched", () => {
    expect(capText("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  test("cuts at a line break when one is within the last tenth", () => {
    const text = `${"a".repeat(95)}\n${"b".repeat(50)}`;
    expect(capText(text, 100)).toEqual({ text: "a".repeat(95), truncated: true });
  });

  test("cuts hard when the nearest line break is too far back", () => {
    const text = `${"a".repeat(10)}\n${"b".repeat(200)}`;
    const r = capText(text, 100);
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(100);
  });
});

describe("chunkText", () => {
  test("empty and short texts", () => {
    expect(chunkText("   ")).toEqual([]);
    expect(chunkText("  one passage  ")).toEqual(["one passage"]);
    expect(chunkText("x".repeat(CHUNK_CHARS))).toHaveLength(1);
  });

  test("every passage is at most the size, and neighbours overlap", () => {
    const words = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkText(words, 400, 80);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
    for (let i = 1; i < chunks.length; i++) {
      const tail = chunks[i - 1]!.slice(-40);
      expect(chunks[i]!.includes(tail.trim().split(" ").slice(-1)[0]!), `chunk ${i}`).toBe(true);
    }
    // Nothing is lost: the last word appears in the last chunk, the first in the first.
    expect(chunks[0]!.startsWith("w0 ")).toBe(true);
    expect(chunks.at(-1)!.endsWith("w2999")).toBe(true);
  });

  test("prefers a paragraph break past the middle of the window", () => {
    const text = `${"a".repeat(300)}\n\n${"b".repeat(300)}`;
    const chunks = chunkText(text, 400, 50);
    expect(chunks[0]).toBe("a".repeat(300));
    expect(chunks[1]!.endsWith("b".repeat(300))).toBe(true);
  });

  test("otherwise cuts after a sentence end, keeping the full stop", () => {
    const sentence = "This sentence is exactly fifty characters long ok. ";
    const text = sentence.repeat(20);
    const chunks = chunkText(text, 400, 50);
    expect(chunks[0]!.endsWith(".")).toBe(true);
    expect(chunks[0]!.length).toBeLessThanOrEqual(400);
  });

  test("a sentence break before the middle is ignored (hard cut at the size)", () => {
    const text = `Short. ${"x".repeat(1000)}`;
    const chunks = chunkText(text, 400, 50);
    expect(chunks[0]).toHaveLength(400);
    expect(chunks[1]!.startsWith(text.slice(350, 360))).toBe(true);
  });

  test("defaults: 1600 characters with 200 of overlap", () => {
    expect(CHUNK_CHARS).toBe(1600);
    expect(CHUNK_OVERLAP).toBe(200);
    const chunks = chunkText("y".repeat(3500));
    expect(chunks.map((c) => c.length)).toEqual([1600, 1600, 700]);
  });

  test("always makes progress even when the overlap is as large as the size", () => {
    const chunks = chunkText("z".repeat(50), 10, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(50);
  });
});
