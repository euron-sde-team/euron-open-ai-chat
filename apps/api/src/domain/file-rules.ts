/**
 * What may be uploaded, how big it may be, and whether the bytes are what the client
 * claimed. Pure, so the policy is unit-testable without storage.
 *
 * Three checks, all required:
 *   1. the declared MIME type is on the allowlist. SVG, HTML and scripts are never
 *      stored with an executable type: text formats (source code included) are kept and
 *      served as text/plain, so nothing can run when opened from a signed URL;
 *   2. the file extension belongs to that MIME type (no "invoice.pdf" that is a .exe);
 *   3. the first bytes of the stored object match the type's magic number. This runs
 *      after the upload, on what actually landed in storage, never on client input.
 */
import type { FileKind, FilePurpose } from "@open-chat/types";

const MB = 1024 * 1024;

/**
 * Hard per-kind ceilings. The user's quota tier (max_file_mb) can only lower these:
 * the effective limit is min(KIND_LIMITS[kind], tier). Images are capped lower because
 * every one is decoded and re-encoded in memory.
 */
export const KIND_LIMITS: Record<FileKind, number> = {
  IMAGE: 20 * MB,
  PDF: 100 * MB,
  DOCUMENT: 50 * MB,
  SPREADSHEET: 50 * MB,
  TEXT: 20 * MB,
  AUDIO: 25 * MB,
  OTHER: 0,
};

type Sniffer = (b: Buffer) => boolean;

interface TypeRule {
  kind: FileKind;
  exts: string[];
  sniff: Sniffer;
  /** Canonical extension used for the storage key. */
  ext: string;
}

const ascii = (b: Buffer, offset: number, s: string) => b.length >= offset + s.length && b.toString("latin1", offset, offset + s.length) === s;
const bytes = (b: Buffer, offset: number, sig: number[]) => b.length >= offset + sig.length && sig.every((x, i) => b[offset + i] === x);

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

/** ISO base media (MP4, MOV, M4A, HEIC): the `ftyp` box at offset 4 carries a major brand. */
function ftypBrand(b: Buffer): string | null {
  return ascii(b, 4, "ftyp") && b.length >= 12 ? b.toString("latin1", 8, 12) : null;
}

const isJpeg: Sniffer = (b) => bytes(b, 0, [0xff, 0xd8, 0xff]);
const isPng: Sniffer = (b) => bytes(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isGif: Sniffer = (b) => ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a");
const isWebp: Sniffer = (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP");
const isWav: Sniffer = (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE");
const isHeic: Sniffer = (b) => {
  const brand = ftypBrand(b);
  return !!brand && HEIF_BRANDS.has(brand);
};
const isMp4: Sniffer = (b) => {
  const brand = ftypBrand(b);
  return !!brand && !HEIF_BRANDS.has(brand) && brand !== "qt  ";
};
const isWebm: Sniffer = (b) => bytes(b, 0, [0x1a, 0x45, 0xdf, 0xa3]) && b.subarray(0, 64).includes("webm", 0, "latin1");
const isMp3: Sniffer = (b) => ascii(b, 0, "ID3") || (b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0);
/** Audio-only MP4: the major brand must be an audio one (M4A, M4B audiobook, M4P protected), so a video cannot pass as audio. */
const M4A_BRANDS = new Set(["M4A ", "M4B ", "M4P "]);
const isM4a: Sniffer = (b) => {
  const brand = ftypBrand(b);
  return !!brand && M4A_BRANDS.has(brand);
};
/** Phones record voice as AAC in an MP4 container with an audio or a generic brand. */
const isM4aOrMp4: Sniffer = (b) => isM4a(b) || isMp4(b);
const isOgg: Sniffer = (b) => ascii(b, 0, "OggS");
const isPdf: Sniffer = (b) => ascii(b, 0, "%PDF-");
const isZip: Sniffer = (b) => bytes(b, 0, [0x50, 0x4b, 0x03, 0x04]);

/** Plain text: valid UTF-8, no NUL bytes, and nothing a browser would render as markup. */
const isPlainText: Sniffer = (b) => {
  if (b.includes(0)) return false;
  // Allow a truncated multi-byte sequence at the very end of the sniffed window.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(b);
  const replacements = (text.match(/�/g) ?? []).length;
  if (replacements > 1) return false;
  return !looksLikeMarkup(b);
};

/**
 * Source code and plain-text formats. They are stored and served as text/plain whatever
 * the browser called them, so a .js or .py file can never run from a signed URL.
 */
const TEXT_EXTS = [
  "txt", "log", "text", "yaml", "yml", "toml", "ini", "cfg", "xml",
  "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "java", "kt", "go", "rs", "rb", "php", "c", "h", "cc", "cpp", "hpp", "cs",
  "swift", "scala", "sql", "sh", "bash", "zsh", "ps1", "r", "lua", "dart", "vue", "svelte", "css", "scss", "html", "htm", "tex",
];

/** Any UTF-8 text without NUL bytes. Markup is fine here: TEXT files are only read and served as text/plain. */
const isText: Sniffer = (b) => {
  if (b.includes(0)) return false;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(b);
  return (text.match(/\uFFFD/g) ?? []).length <= 1;
};

const RULES: Record<string, TypeRule> = {
  "image/jpeg": { kind: "IMAGE", exts: ["jpg", "jpeg"], ext: "jpg", sniff: isJpeg },
  "image/png": { kind: "IMAGE", exts: ["png"], ext: "png", sniff: isPng },
  "image/webp": { kind: "IMAGE", exts: ["webp"], ext: "webp", sniff: isWebp },
  "image/gif": { kind: "IMAGE", exts: ["gif"], ext: "gif", sniff: isGif },
  "image/heic": { kind: "IMAGE", exts: ["heic", "heif"], ext: "heic", sniff: isHeic },
  "image/heif": { kind: "IMAGE", exts: ["heic", "heif"], ext: "heif", sniff: isHeic },
  "application/pdf": { kind: "PDF", exts: ["pdf"], ext: "pdf", sniff: isPdf },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { kind: "DOCUMENT", exts: ["docx"], ext: "docx", sniff: isZip },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { kind: "SPREADSHEET", exts: ["xlsx"], ext: "xlsx", sniff: isZip },
  "text/csv": { kind: "SPREADSHEET", exts: ["csv", "tsv"], ext: "csv", sniff: isPlainText },
  "text/plain": { kind: "TEXT", exts: TEXT_EXTS, ext: "txt", sniff: isText },
  "text/markdown": { kind: "TEXT", exts: ["md", "markdown"], ext: "md", sniff: isText },
  "application/json": { kind: "TEXT", exts: ["json", "jsonl", "ipynb"], ext: "json", sniff: isText },
  "audio/webm": { kind: "AUDIO", exts: ["webm", "weba"], ext: "webm", sniff: isWebm },
  "audio/ogg": { kind: "AUDIO", exts: ["ogg", "oga", "opus"], ext: "ogg", sniff: isOgg },
  "audio/mpeg": { kind: "AUDIO", exts: ["mp3"], ext: "mp3", sniff: isMp3 },
  "audio/mp4": { kind: "AUDIO", exts: ["m4a", "mp4"], ext: "m4a", sniff: isM4aOrMp4 },
  "audio/x-m4a": { kind: "AUDIO", exts: ["m4a"], ext: "m4a", sniff: isM4aOrMp4 },
  "audio/wav": { kind: "AUDIO", exts: ["wav"], ext: "wav", sniff: isWav },
  "audio/x-wav": { kind: "AUDIO", exts: ["wav"], ext: "wav", sniff: isWav },
};

/**
 * Types refused by name, with a clearer message than "not allowed". HTML and scripts may
 * still arrive as TEXT (their bytes are only ever read as text and served as text/plain);
 * what is refused is a client asking to store them with an executable type.
 */
const DANGEROUS_MIME = /^(image\/svg\+xml|text\/html|application\/xhtml\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/x-sh)$/i;
const DANGEROUS_EXT = new Set(["svg", "svgz", "xhtml", "exe", "dll", "bat", "cmd", "msi", "com", "scr", "jar", "app", "dmg"]);

/**
 * Which kinds each purpose accepts. Attachments take everything a model can read:
 * images (vision), documents and text. Project knowledge is text a model searches, so
 * no images. Audio is only for dictation, which never keeps the file.
 */
const PURPOSE_KINDS: Record<FilePurpose, FileKind[]> = {
  AVATAR: ["IMAGE"],
  ATTACHMENT: ["IMAGE", "PDF", "DOCUMENT", "SPREADSHEET", "TEXT"],
  PROJECT: ["PDF", "DOCUMENT", "SPREADSHEET", "TEXT"],
  GENERATED: ["IMAGE"],
};

export const ALLOWED_MIME_TYPES = Object.keys(RULES);
/** What a client may attach to a message (AppMeta.limits.acceptedMimeTypes). */
export const ATTACHMENT_MIME_TYPES = ALLOWED_MIME_TYPES.filter((m) => PURPOSE_KINDS.ATTACHMENT.includes(RULES[m]!.kind));

/** The type a file is stored and served with: every TEXT file is text/plain. */
export function storedMimeType(mime: string): string {
  const rule = RULES[normaliseMime(mime)];
  return rule?.kind === "TEXT" ? "text/plain; charset=utf-8" : normaliseMime(mime);
}

export type DeclaredCheck =
  | { ok: true; kind: FileKind; ext: string; mimeType: string }
  | { ok: false; code: "FILE_TYPE_NOT_ALLOWED" | "FILE_EXTENSION_MISMATCH" | "FILE_TOO_LARGE" | "FILE_PURPOSE_MISMATCH" | "FILE_EMPTY"; message: string; details?: Record<string, unknown> };

export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Normalise "Image/JPEG; charset=x" to "image/jpeg". */
export function normaliseMime(mime: string): string {
  return mime.split(";")[0]!.trim().toLowerCase();
}

/** Validate what the client declares before we hand out an upload URL. */
/**
 * Browsers name text files inconsistently (text/x-python, application/x-sh, or nothing
 * at all). For an extension we read as text, the declared type does not matter: it is
 * normalised to text/plain (or markdown, json, csv) and the bytes are sniffed later.
 */
export function canonicalMime(mime: string, fileName: string): string {
  const m = normaliseMime(mime);
  const ext = extensionOf(fileName);
  if (RULES[m] && RULES[m]!.exts.includes(ext)) return m;
  for (const [type, rule] of Object.entries(RULES)) {
    if ((rule.kind === "TEXT" || type === "text/csv") && rule.exts.includes(ext)) return type;
  }
  return m;
}

export function checkDeclared(input: { purpose: FilePurpose; fileName: string; mimeType: string; sizeBytes: number; maxBytes?: number }): DeclaredCheck {
  const mimeType = canonicalMime(input.mimeType, input.fileName);
  const ext = extensionOf(input.fileName);
  if (DANGEROUS_MIME.test(mimeType) || DANGEROUS_EXT.has(ext)) {
    return { ok: false, code: "FILE_TYPE_NOT_ALLOWED", message: "This file type cannot be uploaded" };
  }
  const rule = RULES[mimeType];
  if (!rule) return { ok: false, code: "FILE_TYPE_NOT_ALLOWED", message: "This file type cannot be uploaded", details: { allowed: ALLOWED_MIME_TYPES } };
  if (!rule.exts.includes(ext)) return { ok: false, code: "FILE_EXTENSION_MISMATCH", message: "The file extension does not match its type" };
  if (!PURPOSE_KINDS[input.purpose].includes(rule.kind)) {
    return { ok: false, code: "FILE_PURPOSE_MISMATCH", message: "This kind of file cannot be used here" };
  }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) return { ok: false, code: "FILE_EMPTY", message: "The file is empty" };
  const limit = Math.min(KIND_LIMITS[rule.kind], input.maxBytes ?? Infinity);
  if (input.sizeBytes > limit) return { ok: false, code: "FILE_TOO_LARGE", message: `Files of this kind can be at most ${Math.round(limit / MB)} MB`, details: { maxBytes: limit } };
  return { ok: true, kind: rule.kind, ext: rule.ext, mimeType };
}

/** True when the stored bytes start with the magic number of the declared type. */
export function sniffMatches(mimeType: string, head: Buffer): boolean {
  const rule = RULES[normaliseMime(mimeType)];
  if (!rule || head.length === 0) return false;
  if (rule.kind !== "TEXT" && rule.kind !== "DOCUMENT" && looksLikeMarkup(head)) return false;
  return rule.sniff(head);
}

/** HTML, SVG or XML that a browser could render (and run scripts in). */
export function looksLikeMarkup(head: Buffer): boolean {
  const start = head
    .subarray(0, 1024)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return /^<(\?xml|!doctype|html|head|body|svg|script|iframe|object|embed|meta|link|style)\b/.test(start);
}

export function kindLimit(kind: FileKind): number {
  return KIND_LIMITS[kind];
}

/** Storage key: files/<purpose>/<yyyy>/<mm>/<id>.<ext>. Nothing from the client file name. */
export function storageKeyFor(purpose: FilePurpose, id: string, ext: string, now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `files/${purpose.toLowerCase()}/${yyyy}/${mm}/${id}.${ext}`;
}

/** Display name: keep it printable and short; it is only ever shown, never used as a path. */
export function cleanFileName(name: string): string {
  // Control characters are exactly what this strips.
  // eslint-disable-next-line no-control-regex
  const base = (name.split(/[\\/]/).pop() ?? "file").replace(/[\u0000-\u001f\u007f"<>]/g, "_").trim();
  return (base || "file").slice(0, 200);
}

