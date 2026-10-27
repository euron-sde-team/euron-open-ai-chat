/**
 * Files: the presigned upload flow, what the server verifies on complete, image
 * processing (EXIF-free re-encode and a thumbnail), document extraction into searchable
 * passages, purpose and tier rules, ownership, and deleting.
 */
import type { ChatFile } from "@open-chat/types";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { config } from "../../src/core/config";
import { newId } from "../../src/core/ids";
import { db } from "../../src/db/kysely";
import { storage } from "../../src/integrations/storage";
import { createUpload, getUrl, jpegWithExif, pdfWithText, pngBytes, putBytes, upload, uploadReady } from "./files-helpers";
import { anon, as, chat, createUser } from "./harness";

const S3 = config.STORAGE === "s3";

describe("upload flow", () => {
  test("presigned PUT, complete, and an image comes back READY: EXIF and GPS gone, auto-rotated, thumbnail written", async () => {
    const ada = await createUser();
    const jpeg = await jpegWithExif();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const ticket = await createUpload(ada, "ATTACHMENT", "holiday.jpg", "image/jpeg", jpeg.length);
    expect(ticket.file).toMatchObject({ status: "PENDING", purpose: "ATTACHMENT", kind: "IMAGE", url: null });
    expect(ticket.headers["Content-Type"] ?? ticket.headers["content-type"]).toBe("image/jpeg");
    expect([200, 204]).toContain((await putBytes(ticket, jpeg)).status);
    const done = (await as(ada).post(`/api/files/${ticket.file.id}/complete`).expect(200)).body as ChatFile;
    // 80x40 with orientation 6 (rotate 90): 40x80 after auto-rotation.
    expect(done).toMatchObject({ id: ticket.file.id, status: "READY", kind: "IMAGE", mimeType: "image/jpeg", width: 40, height: 80, url: expect.any(String), thumbUrl: expect.any(String) });
    const stored = await getUrl(done.url!);
    expect(stored.status).toBe(200);
    const meta = await sharp(stored.body).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(stored.body.includes(Buffer.from("ExampleCam"))).toBe(false);
    const thumb = await getUrl(done.thumbUrl!);
    expect((await sharp(thumb.body).metadata()).format).toBe("webp");
    // GET by id and the list show it to the owner.
    expect((await as(ada).get(`/api/files/${done.id}`).expect(200)).body).toMatchObject({ id: done.id, status: "READY" });
    expect(((await as(ada).get("/api/files?purpose=ATTACHMENT").expect(200)).body as ChatFile[]).map((f) => f.id)).toContain(done.id);
  });

  test("a PNG stays a PNG; a large one is scaled to at most 2048px", async () => {
    const ada = await createUser();
    const big = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toBuffer();
    const file = await uploadReady(ada, "ATTACHMENT", "wide.png", "image/png", big);
    expect(file).toMatchObject({ mimeType: "image/png", width: 2048, height: 683 });
  });

  test("a text document is read into searchable passages", async () => {
    const ada = await createUser();
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} talks about lighthouses and the sea. It is fairly long so that chunking has work to do.`).join("\n\n");
    const file = await uploadReady(ada, "PROJECT", "notes.md", "text/markdown", Buffer.from(text));
    expect(file.kind).toBe("TEXT");
    const row = await db.selectFrom("files").select(["extracted_text", "token_estimate", "mime_type"]).where("id", "=", file.id).executeTakeFirstOrThrow();
    expect(row.extracted_text).toContain("Paragraph 39 talks about lighthouses");
    expect(row.token_estimate).toBe(Math.ceil(row.extracted_text!.length / 4));
    const chunks = await db.selectFrom("file_chunks").select(["ordinal", "content"]).where("file_id", "=", file.id).orderBy("ordinal").execute();
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    expect(chunks[0]!.content).toContain("Paragraph 0");
  });

  test("a PDF is read: text and page count", async () => {
    const ada = await createUser();
    const file = await uploadReady(ada, "ATTACHMENT", "brief.pdf", "application/pdf", pdfWithText("The quarterly brief mentions sunflowers"));
    expect(file).toMatchObject({ kind: "PDF", pageCount: 1 });
    const row = await db.selectFrom("files").select("extracted_text").where("id", "=", file.id).executeTakeFirstOrThrow();
    expect(row.extracted_text).toContain("sunflowers");
  });

  test("source code is stored and served as text/plain whatever the browser called it", async () => {
    const ada = await createUser();
    const file = await uploadReady(ada, "ATTACHMENT", "app.js", "text/javascript", Buffer.from("console.log('hi');\n"));
    expect(file).toMatchObject({ kind: "TEXT", mimeType: "text/plain" });
    const got = await getUrl(file.url!);
    expect(got.type).toMatch(/^text\/plain/);
    if (!S3) expect(got.headers["content-disposition"]).toMatch(/^attachment/);
  });

  test("a .png that is really HTML is REJECTED with FILE_TYPE_MISMATCH and removed from storage", async () => {
    const ada = await createUser();
    const html = Buffer.from("<!doctype html><script>alert(1)</script>");
    const { fileId, res } = await upload(ada, "ATTACHMENT", "photo.png", "image/png", html, 400);
    expect(res.body.code).toBe("FILE_TYPE_MISMATCH");
    const row = await db.selectFrom("files").select(["status", "storage_key", "rejected_reason"]).where("id", "=", fileId).executeTakeFirstOrThrow();
    expect(row.status).toBe("REJECTED");
    expect(row.rejected_reason).toBe("The file content does not match its type");
    expect(await storage().head(row.storage_key)).toBeNull();
    expect((await as(ada).get(`/api/files/${fileId}`).expect(200)).body).toMatchObject({ status: "REJECTED", url: null });
  });

  test("a stored size that differs from the declared one is FILE_SIZE_MISMATCH", async () => {
    const ada = await createUser();
    const png = await pngBytes();
    const ticket = await createUpload(ada, "ATTACHMENT", "a.png", "image/png", png.length);
    const row = await db.selectFrom("files").select("storage_key").where("id", "=", ticket.file.id).executeTakeFirstOrThrow();
    // Write different bytes straight to storage (a client that ignored the signed length).
    await storage().put(row.storage_key, Buffer.concat([png, Buffer.alloc(10)]), "image/png");
    expect((await as(ada).post(`/api/files/${ticket.file.id}/complete`).expect(400)).body.code).toBe("FILE_SIZE_MISMATCH");
    expect((await db.selectFrom("files").select("status").where("id", "=", ticket.file.id).executeTakeFirstOrThrow()).status).toBe("REJECTED");
  });

  test("completing before the bytes arrive is UPLOAD_MISSING; the signed PUT enforces the length and type", async () => {
    const ada = await createUser();
    const png = await pngBytes();
    const ticket = await createUpload(ada, "ATTACHMENT", "a.png", "image/png", png.length + 10);
    expect((await as(ada).post(`/api/files/${ticket.file.id}/complete`).expect(400)).body.code).toBe("UPLOAD_MISSING");
    if (!S3) {
      expect((await putBytes(ticket, png)).status).toBe(403);
      const right = await createUpload(ada, "ATTACHMENT", "b.png", "image/png", png.length);
      expect((await putBytes({ uploadUrl: right.uploadUrl, headers: { "Content-Type": "text/html" } }, png)).status).toBe(403);
    }
  });

  test("an image that cannot be decoded is REJECTED in processing", async () => {
    const ada = await createUser();
    const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
    const { file } = await upload(ada, "ATTACHMENT", "broken.png", "image/png", broken);
    expect(file).toMatchObject({ status: "REJECTED", rejectedReason: "The image could not be read" });
  });
});

describe("rules checked up front", () => {
  test("types, extensions, purposes and sizes", async () => {
    const ada = await createUser();
    const bad = [
      { purpose: "ATTACHMENT", fileName: "x.svg", mimeType: "image/svg+xml", code: "FILE_TYPE_NOT_ALLOWED", status: 400 },
      { purpose: "ATTACHMENT", fileName: "x.xhtml", mimeType: "application/xhtml+xml", code: "FILE_TYPE_NOT_ALLOWED", status: 400 },
      { purpose: "ATTACHMENT", fileName: "run.exe", mimeType: "application/octet-stream", code: "FILE_TYPE_NOT_ALLOWED", status: 400 },
      { purpose: "ATTACHMENT", fileName: "x.pdf", mimeType: "image/png", code: "FILE_EXTENSION_MISMATCH", status: 400 },
      { purpose: "AVATAR", fileName: "cv.pdf", mimeType: "application/pdf", code: "FILE_PURPOSE_MISMATCH", status: 400 },
      { purpose: "PROJECT", fileName: "me.png", mimeType: "image/png", code: "FILE_PURPOSE_MISMATCH", status: 400 },
      { purpose: "ATTACHMENT", fileName: "voice.wav", mimeType: "audio/wav", code: "FILE_PURPOSE_MISMATCH", status: 400 },
      { purpose: "ATTACHMENT", fileName: "big.png", mimeType: "image/png", code: "FILE_TOO_LARGE", status: 413, sizeBytes: 21 * 1024 * 1024 },
    ];
    for (const b of bad) {
      const res = await as(ada).post("/api/files").send({ purpose: b.purpose, fileName: b.fileName, mimeType: b.mimeType, sizeBytes: b.sizeBytes ?? 100 });
      expect([res.status, res.body.code], b.fileName).toEqual([b.status, b.code]);
    }
    // HTML is accepted only as text: stored and served as text/plain, never text/html.
    const html = (await as(ada).post("/api/files").send({ purpose: "ATTACHMENT", fileName: "page.html", mimeType: "text/html", sizeBytes: 100 }).expect(201)).body;
    expect(html.file).toMatchObject({ kind: "TEXT", mimeType: "text/plain" });
    expect(html.headers["Content-Type"] ?? html.headers["content-type"]).toMatch(/^text\/plain/);
    expect((await as(ada).post("/api/files").send({ purpose: "GENERATED", fileName: "a.png", mimeType: "image/png", sizeBytes: 100 }).expect(400)).body.code).toBe("VALIDATION_FAILED");
    expect((await as(ada).post("/api/files").send({ purpose: "ATTACHMENT", fileName: "a.png", mimeType: "image/png", sizeBytes: 100, storageKey: "files/x" }).expect(400)).body.code).toBe("VALIDATION_FAILED");
    await anon().post("/api/files").send({ purpose: "ATTACHMENT", fileName: "a.png", mimeType: "image/png", sizeBytes: 100 }).expect(401);
  });

  test("the user's tier max_file_mb lowers the kind limit", async () => {
    const ada = await createUser();
    const tierId = newId();
    await db.insertInto("quota_tiers").values({ id: tierId, name: `Tiny ${tierId}`, daily_tokens: null, daily_images: null, max_file_mb: 1 }).execute();
    await db.updateTable("users").set({ quota_tier_id: tierId }).where("id", "=", ada.id).execute();
    const over = await as(ada).post("/api/files").send({ purpose: "ATTACHMENT", fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 2 * 1024 * 1024 }).expect(413);
    expect(over.body).toMatchObject({ code: "FILE_TOO_LARGE", details: { maxBytes: 1024 * 1024 } });
    await as(ada).post("/api/files").send({ purpose: "ATTACHMENT", fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 1024 * 1024 }).expect(201);
    expect(((await as(ada).get("/api/me/usage").expect(200)).body as { maxFileMb: number }).maxFileMb).toBe(1);
  });

  test("a suspended account cannot start an upload", async () => {
    const u = await createUser({ status: "SUSPENDED" });
    expect((await as(u).post("/api/files").send({ purpose: "ATTACHMENT", fileName: "a.png", mimeType: "image/png", sizeBytes: 100 }).expect(403)).body.code).toBe("ACCOUNT_RESTRICTED");
  });
});

describe("ownership and deleting", () => {
  test("another user's file is a 404 everywhere", async () => {
    const ada = await createUser();
    const bob = await createUser();
    const png = await pngBytes();
    const ticket = await createUpload(ada, "ATTACHMENT", "a.png", "image/png", png.length);
    await putBytes(ticket, png);
    await as(bob).post(`/api/files/${ticket.file.id}/complete`).expect(404);
    await as(ada).post(`/api/files/${ticket.file.id}/complete`).expect(200);
    expect((await as(bob).get(`/api/files/${ticket.file.id}`).expect(404)).body.code).toBe("FILE_NOT_FOUND");
    await as(bob).delete(`/api/files/${ticket.file.id}`).expect(404);
    expect(((await as(bob).get("/api/files").expect(200)).body as ChatFile[]).map((f) => f.id)).not.toContain(ticket.file.id);
  });

  test("an unused file is deleted; a file sent in a message is FILE_IN_USE", async () => {
    const ada = await createUser();
    const loose = await uploadReady(ada, "ATTACHMENT", "loose.png", "image/png", await pngBytes());
    await as(ada).delete(`/api/files/${loose.id}`).expect(204);
    await as(ada).get(`/api/files/${loose.id}`).expect(404);

    const sent = await uploadReady(ada, "ATTACHMENT", "sent.png", "image/png", await pngBytes(32, 32, [1, 200, 1]));
    await chat(ada, "Look at this picture", { fileIds: [sent.id] });
    expect((await as(ada).delete(`/api/files/${sent.id}`).expect(409)).body.code).toBe("FILE_IN_USE");
  });

  test("a file still processing or rejected cannot be attached", async () => {
    const ada = await createUser();
    const ticket = await createUpload(ada, "ATTACHMENT", "a.png", "image/png", 100);
    expect((await as(ada).post("/api/chats/new/messages").send({ content: "x", fileIds: [ticket.file.id] }).expect(409)).body.code).toBe("FILE_NOT_READY");
    const { fileId } = await upload(ada, "ATTACHMENT", "fake.png", "image/png", Buffer.from("<html></html>"), 400);
    expect((await as(ada).post("/api/chats/new/messages").send({ content: "x", fileIds: [fileId] }).expect(400)).body.code).toBe("FILE_REJECTED");
  });

  test("the avatar must be your own AVATAR file", async () => {
    const ada = await createUser();
    const avatar = await uploadReady(ada, "AVATAR", "me.png", "image/png", await pngBytes());
    const attachment = await uploadReady(ada, "ATTACHMENT", "a.png", "image/png", await pngBytes());
    expect((await as(ada).patch("/api/users/me").send({ avatarFileId: attachment.id }).expect(400)).body.code).toBe("FILE_PURPOSE_MISMATCH");
    const me = (await as(ada).patch("/api/users/me").send({ avatarFileId: avatar.id }).expect(200)).body;
    expect(me.avatarUrl).toEqual(expect.any(String));
    await as(ada).delete(`/api/files/${avatar.id}`).expect(204);
    expect((await as(ada).get("/api/users/me").expect(200)).body.avatarUrl).toBeNull();
  });
});

describe("local signed links", () => {
  test.skipIf(S3)("served with nosniff and a sandbox CSP; documents download as attachments; tampered tokens fail", async () => {
    const ada = await createUser();
    const doc = await uploadReady(ada, "ATTACHMENT", "notes.txt", "text/plain", Buffer.from("hello there\n"));
    const got = await getUrl(doc.url!);
    expect(got.status).toBe(200);
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.headers["content-security-policy"]).toContain("sandbox");
    expect(got.headers["content-disposition"]).toMatch(/^attachment/);
    const img = await uploadReady(ada, "ATTACHMENT", "a.png", "image/png", await pngBytes());
    expect((await getUrl(img.url!)).headers["content-disposition"]).toBe("inline");
    const tampered = doc.url!.replace(/.$/, (c: string) => (c === "A" ? "B" : "A"));
    expect((await getUrl(tampered)).status).toBe(403);
  });
});
