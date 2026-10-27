import { describe, expect, it, vi } from "vitest";
import { HttpClient, mimeTypeOf, uploadFile } from "../src";
import { json } from "./fixtures";

class FakeXhr {
  static instances: FakeXhr[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  status = 0;
  body: unknown;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor(private readonly outcome: "ok" | "fail" | "error") {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  abort() {
    this.onabort?.();
  }
  send(body: unknown) {
    this.body = body;
    queueMicrotask(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
      if (this.outcome === "error") return this.onerror?.();
      this.status = this.outcome === "ok" ? 200 : 403;
      this.onload?.();
    });
  }
}

function client(handler: (url: string, init: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => handler(url, init));
  return { http: new HttpClient({ baseUrl: "/api", getAccessToken: () => "t", fetch: fetchMock as unknown as typeof fetch }), fetchMock };
}

const file = (status: string) => ({ id: "f1", purpose: "ATTACHMENT", kind: "IMAGE", mimeType: "image/png", fileName: "a.png", sizeBytes: 4, width: 1, height: 1, pageCount: null, status, rejectedReason: status === "REJECTED" ? "The image could not be read" : null, url: status === "READY" ? "u" : null, thumbUrl: null, createdAt: "" });
const ticket = { file: file("PENDING"), uploadUrl: "https://s3.local/bucket/key?sig=1", headers: { "Content-Type": "image/png" }, expiresAt: "" };

describe("uploadFile", () => {
  it("asks for a ticket, PUTs with the presigned headers and progress, completes and waits for READY", async () => {
    let gets = 0;
    const { http, fetchMock } = client((url, init) => {
      if (url === "/api/files") return json(201, ticket);
      if (url.endsWith("/complete")) return json(200, file("PROCESSING"));
      gets++;
      return json(200, file(init.method === "GET" && gets > 1 ? "READY" : "PROCESSING"));
    });
    const progress: number[] = [];
    const blob = new File([new Uint8Array([1, 2, 3, 4])], "a.png", { type: "image/png" });
    const result = await uploadFile(http, { purpose: "ATTACHMENT", file: blob, onProgress: (f) => progress.push(f), createXhr: () => new FakeXhr("ok") as unknown as XMLHttpRequest });
    expect(result.status).toBe("READY");
    const [first, second] = fetchMock.mock.calls;
    expect(JSON.parse(first![1].body as string)).toEqual({ purpose: "ATTACHMENT", fileName: "a.png", mimeType: "image/png", sizeBytes: 4 });
    expect(second![0]).toBe("/api/files/f1/complete");
    const xhr = FakeXhr.instances.at(-1)!;
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe(ticket.uploadUrl);
    expect(xhr.headers).toEqual({ "Content-Type": "image/png" });
    expect(progress).toEqual([0.5]);
  }, 10_000);

  it("throws the server's reason when processing rejects the file", async () => {
    const { http } = client((url) => (url === "/api/files" ? json(201, ticket) : json(200, file("REJECTED"))));
    const blob = new File(["x"], "a.png", { type: "image/png" });
    await expect(uploadFile(http, { purpose: "ATTACHMENT", file: blob, createXhr: () => new FakeXhr("ok") as unknown as XMLHttpRequest })).rejects.toMatchObject({ code: "FILE_REJECTED", message: "The image could not be read" });
  });

  it("rejects with UPLOAD_FAILED when storage refuses the PUT", async () => {
    const { http } = client((url) => (url === "/api/files" ? json(201, ticket) : json(200, file("READY"))));
    const blob = new File(["x"], "a.png", { type: "image/png" });
    await expect(uploadFile(http, { purpose: "ATTACHMENT", file: blob, createXhr: () => new FakeXhr("fail") as unknown as XMLHttpRequest })).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
  });

  it("maps an XHR network error to NETWORK_ERROR", async () => {
    const { http } = client((url) => (url === "/api/files" ? json(201, ticket) : json(200, file("READY"))));
    const blob = new File(["x"], "a.png", { type: "image/png" });
    await expect(uploadFile(http, { purpose: "ATTACHMENT", file: blob, createXhr: () => new FakeXhr("error") as unknown as XMLHttpRequest })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});

describe("mimeTypeOf", () => {
  it("infers a type from the extension when the browser gives none", () => {
    expect(mimeTypeOf({ type: "", name: "IMG_1.HEIC" })).toBe("image/heic");
    expect(mimeTypeOf({ type: "", name: "notes.md" })).toBe("text/markdown");
    expect(mimeTypeOf({ type: "", name: "noext" })).toBe("application/octet-stream");
  });
});
