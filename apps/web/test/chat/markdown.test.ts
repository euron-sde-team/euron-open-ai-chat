import { describe, expect, it } from "vitest";
import { linkCitations, normaliseMath, prepareMarkdown } from "@/lib/chat/markdown";

const sources = [
  { n: 1, title: "One", url: "https://example.org/a", domain: "example.org", snippet: "", publishedAt: null },
  { n: 2, title: "Two", url: "https://example.com/b", domain: "example.com", snippet: "", publishedAt: null },
];

describe("prepareMarkdown", () => {
  it("turns \\[ \\] and \\( \\) into dollar math", () => {
    expect(normaliseMath("a \\(x^2\\) b \\[y\\]")).toBe("a $x^2$ b $$y$$");
  });
  it("links known citations and leaves unknown numbers and real links alone", () => {
    expect(linkCitations("Fact [1], more [2], none [7], link [1](https://x.example)", sources)).toBe('Fact [1](https://example.org/a "cite:1"), more [2](https://example.com/b "cite:2"), none [7], link [1](https://x.example)');
  });
  it("never touches code blocks or inline code", () => {
    const text = "See [1]\n\n```py\narr[1] = \\(x\\)\n```\n\nand `a[2]`";
    const out = prepareMarkdown(text, sources);
    expect(out).toContain('[1](https://example.org/a "cite:1")');
    expect(out).toContain("arr[1] = \\(x\\)");
    expect(out).toContain("`a[2]`");
  });
  it("is a no-op without sources", () => {
    expect(prepareMarkdown("plain [1] text")).toBe("plain [1] text");
  });
});
