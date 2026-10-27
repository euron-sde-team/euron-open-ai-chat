/** Upload helpers: presigned PUT (local storage in-process, S3 over HTTP), signed GET, and create + put + complete. */
import type { ChatFile, UploadTicket } from "@open-chat/types";
import request from "supertest";
import sharp from "sharp";
import { config } from "../../src/core/config";
import { app, as, type TestUser } from "./harness";

/** PUT bytes to a presigned URL: in-process for local storage, over HTTP for S3. */
export async function putBytes(ticket: { uploadUrl: string; headers: Record<string, string> }, body: Buffer): Promise<{ status: number }> {
  const origin = config.PUBLIC_API_URL.replace(/\/$/, "");
  if (ticket.uploadUrl.startsWith(origin)) {
    let r = request(app).put(ticket.uploadUrl.slice(origin.length));
    for (const [k, v] of Object.entries(ticket.headers)) r = r.set(k, v);
    return r.send(body);
  }
  const res = await fetch(ticket.uploadUrl, { method: "PUT", headers: ticket.headers, body });
  return { status: res.status };
}

/** GET a signed URL (local or S3) and return status, headers and bytes. */
export async function getUrl(url: string): Promise<{ status: number; type: string | null; body: Buffer; headers: Record<string, string> }> {
  const origin = config.PUBLIC_API_URL.replace(/\/$/, "");
  if (url.startsWith(origin)) {
    const res = await request(app)
      .get(url.slice(origin.length))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    return { status: res.status, type: res.headers["content-type"] ?? null, body: res.body as Buffer, headers: res.headers as Record<string, string> };
  }
  const res = await fetch(url);
  return { status: res.status, type: res.headers.get("content-type"), body: Buffer.from(await res.arrayBuffer()), headers: Object.fromEntries(res.headers.entries()) };
}

/** Start an upload (expects 201) and return the ticket. */
export async function createUpload(user: TestUser, purpose: "AVATAR" | "ATTACHMENT" | "PROJECT", fileName: string, mimeType: string, sizeBytes: number): Promise<UploadTicket> {
  const res = await as(user).post("/api/files").send({ purpose, fileName, mimeType, sizeBytes });
  if (res.status !== 201) throw new Error(`create upload answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as UploadTicket;
}

/** Create, upload and complete. Returns the ticket and the complete response. */
export async function upload(user: TestUser, purpose: "AVATAR" | "ATTACHMENT" | "PROJECT", fileName: string, mimeType: string, bytes: Buffer, expectStatus = 200) {
  const ticket = await createUpload(user, purpose, fileName, mimeType, bytes.length);
  const put = await putBytes(ticket, bytes);
  if (put.status !== 204 && put.status !== 200) throw new Error(`upload PUT failed with ${put.status}`);
  const done = await as(user).post(`/api/files/${ticket.file.id}/complete`).expect(expectStatus);
  return { ticket, fileId: ticket.file.id, res: done, file: done.body as ChatFile };
}

/** Upload and expect READY (inline jobs make it ready during complete). */
export async function uploadReady(user: TestUser, purpose: "AVATAR" | "ATTACHMENT" | "PROJECT", fileName: string, mimeType: string, bytes: Buffer): Promise<ChatFile> {
  const { file } = await upload(user, purpose, fileName, mimeType, bytes);
  if (file.status !== "READY") throw new Error(`file is ${file.status}: ${file.rejectedReason}`);
  return file;
}

/** A small real PNG (sharp-made), different colours per seed. */
export async function pngBytes(width = 64, height = 48, rgb: [number, number, number] = [200, 80, 40]): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .png()
    .toBuffer();
}

/** A JPEG carrying EXIF (camera make and GPS-ish fields) and an orientation tag. */
export async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 80, height: 40, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: "ExampleCam", Model: "Tester 1" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } } })
    .toBuffer();
}

/** A minimal one-page PDF with real extractable text. */
export function pdfWithText(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** Half a second of silence as 16 kHz mono WAV. */
export function wavBytes(): Buffer {
  const samples = 8000;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

/** The start of a WebM file (EBML header with the webm doctype), enough for the magic-number check. */
export function webmBytes(): Buffer {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from("webm", "latin1"), Buffer.alloc(200, 0x11)]);
}
