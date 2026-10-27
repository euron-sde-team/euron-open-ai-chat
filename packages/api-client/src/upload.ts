/**
 * Uploading a file: ask the API for a ticket (POST /files), PUT the bytes straight to
 * storage with the exact headers it returned, then POST /files/:id/complete and wait for
 * the file to be READY (images are re-encoded, documents are read). Progress is reported
 * while the bytes go up (XMLHttpRequest, which every browser and React Native supports).
 */
import type { ChatFile, FilePurpose, UploadTicket } from "@open-chat/types";
import { ApiError, networkError } from "./errors";
import type { HttpClient } from "./http";

export type { UploadTicket };

export interface UploadOptions {
  purpose: Exclude<FilePurpose, "GENERATED">;
  file: Blob & { name?: string };
  /** 0..1 as the bytes go up. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Wait for READY after complete (default true). */
  waitUntilReady?: boolean;
  /** Injected for tests. */
  createXhr?: () => XMLHttpRequest;
}

const EXT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  md: "text/markdown",
  json: "application/json",
  txt: "text/plain",
};

/** The browser's type, or one inferred from the extension (HEIC and code files often arrive untyped). */
export function mimeTypeOf(file: { type?: string; name?: string }): string {
  if (file.type) return file.type;
  const ext = (file.name ?? "").split(".").pop()?.toLowerCase() ?? "";
  return EXT_TYPES[ext] ?? "application/octet-stream";
}

/** PUT bytes with progress. Resolves when storage accepted them. */
export function putWithProgress(url: string, file: Blob, headers: Record<string, string>, opts: Pick<UploadOptions, "onProgress" | "signal" | "createXhr"> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = opts.createXhr ? opts.createXhr() : new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError({ status: xhr.status, message: "The upload was rejected by storage", code: "UPLOAD_FAILED" })));
    xhr.onerror = () => reject(networkError(new Error("upload failed")));
    xhr.onabort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    opts.signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

/** Upload one file end to end and return it READY (or throw with the rejection reason). */
export async function uploadFile(http: HttpClient, opts: UploadOptions): Promise<ChatFile> {
  const name = opts.file.name ?? "file";
  const ticket = await http.request<UploadTicket>("POST", "/files", { body: { purpose: opts.purpose, fileName: name, mimeType: mimeTypeOf({ type: opts.file.type, name }), sizeBytes: opts.file.size }, signal: opts.signal });
  await putWithProgress(ticket.uploadUrl, opts.file, ticket.headers, opts);
  let file = await http.request<ChatFile>("POST", `/files/${encodeURIComponent(ticket.file.id)}/complete`, { signal: opts.signal });
  if (opts.waitUntilReady === false) return file;
  for (let i = 0; file.status === "PROCESSING" && i < 120; i++) {
    await new Promise((r) => setTimeout(r, Math.min(2000, 250 + i * 150)));
    file = await http.request<ChatFile>("GET", `/files/${encodeURIComponent(file.id)}`, { signal: opts.signal });
  }
  if (file.status === "REJECTED") throw new ApiError({ status: 422, message: file.rejectedReason ?? "The file could not be read", code: "FILE_REJECTED" });
  return file;
}
