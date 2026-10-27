import { describe, expect, test } from "vitest";
import {
  ALLOWED_MIME_TYPES,
  ATTACHMENT_MIME_TYPES,
  canonicalMime,
  checkDeclared,
  cleanFileName,
  extensionOf,
  KIND_LIMITS,
  looksLikeMarkup,
  normaliseMime,
  sniffMatches,
  storageKeyFor,
  storedMimeType,
} from "../../src/domain/file-rules";

const MB = 1024 * 1024;
const pad = (head: number[] | Buffer, total = 64) => Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, total - Buffer.from(head).length))]);
const ftyp = (brand: string) => pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftyp" + brand, "latin1")]));

const SAMPLES: Record<string, Buffer> = {
  "image/jpeg": pad([0xff, 0xd8, 0xff, 0xe0]),
  "image/png": pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/gif": pad(Buffer.from("GIF89a")),
  "image/webp": pad(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])),
  "image/heic": ftyp("heic"),
  "application/pdf": pad(Buffer.from("%PDF-1.7\n")),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": pad([0x50, 0x4b, 0x03, 0x04]),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": pad([0x50, 0x4b, 0x03, 0x04]),
  "text/csv": Buffer.from("a,b,c\n1,2,3\n"),
  "text/plain": Buffer.from("hello there\n"),
  "text/markdown": Buffer.from("# Title\n\nSome text.\n"),
  "application/json": Buffer.from('{"a":1}'),
  "audio/webm": pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("\x42\x82\x84webm", "latin1")])),
  "audio/ogg": pad(Buffer.from("OggS")),
  "audio/mpeg": pad(Buffer.from("ID3\x04")),
  "audio/mp4": ftyp("M4A "),
  "audio/wav": pad(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")])),
};

describe("the allowlist", () => {
  test("covers images, documents, text and audio; nothing executable", () => {
    for (const m of ["image/jpeg", "image/png", "application/pdf", "text/plain", "audio/webm", "audio/wav"]) expect(ALLOWED_MIME_TYPES).toContain(m);
    for (const m of ["image/svg+xml", "text/html", "application/javascript", "application/x-msdownload", "application/zip"]) expect(ALLOWED_MIME_TYPES).not.toContain(m);
  });

  test("attachments accept what a model reads, never audio", () => {
    expect(ATTACHMENT_MIME_TYPES).toContain("image/png");
    expect(ATTACHMENT_MIME_TYPES).toContain("application/pdf");
    expect(ATTACHMENT_MIME_TYPES).toContain("text/plain");
    expect(ATTACHMENT_MIME_TYPES.some((m) => m.startsWith("audio/"))).toBe(false);
  });
});

describe("checkDeclared", () => {
  const ok = (purpose: "AVATAR" | "ATTACHMENT" | "PROJECT", fileName: string, mimeType: string, sizeBytes = 1000, maxBytes?: number) => checkDeclared({ purpose, fileName, mimeType, sizeBytes, maxBytes });

  test("a matching type, extension and purpose passes with its kind and canonical extension", () => {
    expect(ok("ATTACHMENT", "photo.JPEG", "image/jpeg")).toEqual({ ok: true, kind: "IMAGE", ext: "jpg", mimeType: "image/jpeg" });
    expect(ok("PROJECT", "notes.pdf", "Application/PDF; charset=binary")).toEqual({ ok: true, kind: "PDF", ext: "pdf", mimeType: "application/pdf" });
    expect(ok("AVATAR", "me.png", "image/png")).toMatchObject({ ok: true, kind: "IMAGE" });
  });

  test("an unknown type is FILE_TYPE_NOT_ALLOWED with the allowlist in details", () => {
    const r = ok("ATTACHMENT", "a.zip", "application/zip");
    expect(r).toMatchObject({ ok: false, code: "FILE_TYPE_NOT_ALLOWED" });
    expect(r.ok === false && (r.details as { allowed: string[] }).allowed).toEqual(ALLOWED_MIME_TYPES);
  });

  test("an extension that does not belong to the type is FILE_EXTENSION_MISMATCH", () => {
    expect(ok("ATTACHMENT", "invoice.pdf", "image/png")).toMatchObject({ ok: false, code: "FILE_EXTENSION_MISMATCH" });
    expect(ok("ATTACHMENT", "photo.png", "image/jpeg")).toMatchObject({ ok: false, code: "FILE_EXTENSION_MISMATCH" });
    expect(ok("ATTACHMENT", "noextension", "image/png")).toMatchObject({ ok: false, code: "FILE_EXTENSION_MISMATCH" });
  });

  test("code files are canonicalised to TEXT whatever the browser called them", () => {
    expect(ok("ATTACHMENT", "script.py", "text/x-python")).toEqual({ ok: true, kind: "TEXT", ext: "txt", mimeType: "text/plain" });
    expect(ok("ATTACHMENT", "main.ts", "video/mp2t")).toMatchObject({ ok: true, kind: "TEXT", mimeType: "text/plain" });
    expect(ok("PROJECT", "README.md", "")).toMatchObject({ ok: true, kind: "TEXT", mimeType: "text/markdown" });
    expect(ok("ATTACHMENT", "data.tsv", "application/octet-stream")).toMatchObject({ ok: true, kind: "SPREADSHEET", mimeType: "text/csv" });
    expect(ok("ATTACHMENT", "page.html", "text/html")).toMatchObject({ ok: true, kind: "TEXT", mimeType: "text/plain" });
    expect(canonicalMime("application/x-sh", "run.sh")).toBe("text/plain");
    expect(canonicalMime("image/png", "a.png")).toBe("image/png");
  });

  test("every TEXT type is stored and served as text/plain", () => {
    expect(storedMimeType("text/markdown")).toBe("text/plain; charset=utf-8");
    expect(storedMimeType("application/json")).toBe("text/plain; charset=utf-8");
    expect(storedMimeType("text/plain")).toBe("text/plain; charset=utf-8");
    expect(storedMimeType("image/png")).toBe("image/png");
    expect(storedMimeType("text/csv")).toBe("text/csv");
  });

  test("dangerous types and extensions are refused by name", () => {
    expect(ok("ATTACHMENT", "logo.svg", "image/svg+xml")).toMatchObject({ ok: false, code: "FILE_TYPE_NOT_ALLOWED" });
    expect(ok("ATTACHMENT", "logo.svg", "image/png")).toMatchObject({ ok: false, code: "FILE_TYPE_NOT_ALLOWED" });
    expect(ok("ATTACHMENT", "setup.exe", "application/octet-stream")).toMatchObject({ ok: false, code: "FILE_TYPE_NOT_ALLOWED" });
    expect(ok("ATTACHMENT", "x.xhtml", "application/xhtml+xml")).toMatchObject({ ok: false, code: "FILE_TYPE_NOT_ALLOWED" });
    expect(ok("ATTACHMENT", "a.bin", "text/javascript")).toMatchObject({ ok: false, code: "FILE_TYPE_NOT_ALLOWED" });
  });

  test("each purpose accepts only its kinds", () => {
    expect(ok("AVATAR", "cv.pdf", "application/pdf")).toMatchObject({ ok: false, code: "FILE_PURPOSE_MISMATCH" });
    expect(ok("PROJECT", "photo.png", "image/png")).toMatchObject({ ok: false, code: "FILE_PURPOSE_MISMATCH" });
    expect(ok("ATTACHMENT", "voice.wav", "audio/wav")).toMatchObject({ ok: false, code: "FILE_PURPOSE_MISMATCH" });
    expect(ok("PROJECT", "sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toMatchObject({ ok: true, kind: "SPREADSHEET" });
  });

  test("empty and non-integer sizes are FILE_EMPTY", () => {
    expect(ok("ATTACHMENT", "a.txt", "text/plain", 0)).toMatchObject({ ok: false, code: "FILE_EMPTY" });
    expect(ok("ATTACHMENT", "a.txt", "text/plain", 1.5)).toMatchObject({ ok: false, code: "FILE_EMPTY" });
  });

  test("the limit is the smaller of the kind ceiling and the tier's max bytes", () => {
    expect(ok("ATTACHMENT", "a.png", "image/png", KIND_LIMITS.IMAGE)).toMatchObject({ ok: true });
    expect(ok("ATTACHMENT", "a.png", "image/png", KIND_LIMITS.IMAGE + 1)).toMatchObject({ ok: false, code: "FILE_TOO_LARGE", details: { maxBytes: 20 * MB } });
    expect(ok("ATTACHMENT", "a.pdf", "application/pdf", 60 * MB)).toMatchObject({ ok: true });
    expect(ok("ATTACHMENT", "a.pdf", "application/pdf", 60 * MB, 25 * MB)).toMatchObject({ ok: false, code: "FILE_TOO_LARGE", details: { maxBytes: 25 * MB } });
    expect(ok("ATTACHMENT", "a.png", "image/png", 21 * MB, 500 * MB)).toMatchObject({ ok: false, code: "FILE_TOO_LARGE", details: { maxBytes: 20 * MB } });
    const r = ok("ATTACHMENT", "a.pdf", "application/pdf", 2 * MB, 1 * MB);
    expect(r.ok === false && r.message).toMatch(/1 MB/);
  });
});

describe("sniffMatches", () => {
  for (const [mime, buf] of Object.entries(SAMPLES)) {
    test(`accepts real ${mime}`, () => expect(sniffMatches(mime, buf)).toBe(true));
  }

  test("refuses bytes of another type, and empty bytes", () => {
    expect(sniffMatches("image/png", SAMPLES["image/jpeg"]!)).toBe(false);
    expect(sniffMatches("application/pdf", SAMPLES["image/png"]!)).toBe(false);
    expect(sniffMatches("audio/webm", SAMPLES["audio/ogg"]!)).toBe(false);
    expect(sniffMatches("image/png", Buffer.alloc(0))).toBe(false);
    expect(sniffMatches("application/zip", SAMPLES["image/png"]!)).toBe(false);
  });

  test("HEIC is not MP4 and a video brand is not M4A audio", () => {
    expect(sniffMatches("audio/mp4", ftyp("heic"))).toBe(false);
    expect(sniffMatches("image/heic", ftyp("isom"))).toBe(false);
    expect(sniffMatches("audio/mp4", ftyp("isom"))).toBe(true);
  });

  test("markup disguised as an image, a PDF or CSV is refused", () => {
    expect(sniffMatches("image/png", Buffer.from("<svg onload=alert(1)>"))).toBe(false);
    expect(sniffMatches("text/csv", Buffer.from("<!doctype html><script>x</script>"))).toBe(false);
    expect(sniffMatches("application/pdf", Buffer.from("\uFEFF  <html><body>%PDF-"))).toBe(false);
  });

  test("TEXT files may contain markup (they are served as text/plain), but never NUL bytes or binary garbage", () => {
    expect(sniffMatches("text/plain", Buffer.from("<html><script>alert(1)</script></html>"))).toBe(true);
    expect(sniffMatches("text/plain", Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
    expect(sniffMatches("text/plain", Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x80, 0x81]))).toBe(false);
    expect(sniffMatches("text/csv", Buffer.from([0x61, 0x00]))).toBe(false);
  });

  test("a multi-byte character cut at the end of the sniff window is still text", () => {
    const text = Buffer.from("caf\u00e9 au lait \u00e9");
    expect(sniffMatches("text/plain", text.subarray(0, text.length - 1))).toBe(true);
  });
});

describe("looksLikeMarkup", () => {
  test("HTML, SVG, XML and script openers, after a BOM and whitespace, in any case", () => {
    for (const s of ["<!DOCTYPE html>", "<html>", "  \n<svg xmlns='x'>", "\uFEFF<?xml version='1.0'?>", "<SCRIPT>", "<iframe src=x>", "<meta charset=utf-8>"]) expect(looksLikeMarkup(Buffer.from(s)), s).toBe(true);
    for (const s of ["hello <b>world</b>", "a,b,c", "%PDF-1.7", "<notatag"]) expect(looksLikeMarkup(Buffer.from(s)), s).toBe(false);
  });
});

describe("names and keys", () => {
  test("extensionOf and normaliseMime", () => {
    expect(extensionOf("a/b/Report.Final.PDF")).toBe("pdf");
    expect(extensionOf(".bashrc")).toBe("");
    expect(extensionOf("C:\\x\\y.txt")).toBe("txt");
    expect(normaliseMime(" Image/JPEG; q=1")).toBe("image/jpeg");
  });

  test("storage keys never include the client file name", () => {
    expect(storageKeyFor("ATTACHMENT", "01ABC", "png", new Date("2026-03-04T00:00:00Z"))).toBe("files/attachment/2026/03/01ABC.png");
  });

  test("display names lose paths, control characters and quotes", () => {
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName('a"b<c>\u0001.txt')).toBe("a_b_c__.txt");
    expect(cleanFileName("   ")).toBe("file");
    expect(cleanFileName("x".repeat(300))).toHaveLength(200);
  });
});
