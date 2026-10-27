/**
 * Test harness: the app in-process, fast user creation, the starter model catalogue
 * (with the stub provider), and helpers to send messages and read a turn's events.
 *
 *   const ada = await createUser();                              // ACTIVE, verified USER
 *   const { started, events } = await chat(ada, "Hello there");  // send to "new", follow to done
 *   expect(events.at(-1)).toMatchObject({ type: "done", status: "COMPLETE" });
 *
 * Turns run after the HTTP response, so tests either read the event stream of the send
 * itself (Accept: text/event-stream), follow GET /api/turns/:id/events to `done`, or
 * read events incrementally from a real listening server (`openEvents`).
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { TurnEvent, TurnStarted } from "@open-chat/types";
import { afterAll, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { newId } from "../../src/core/ids";
import { db, initDbTypes } from "../../src/db/kysely";
import { ensureStarterCatalog } from "../../src/demo/catalog";
import { registerAllJobs } from "../../src/jobs";
import { hashPassword } from "../../src/security/passwords";
import { signAccessToken } from "../../src/security/tokens";
import { clearModelCache } from "../../src/services/models.service";
import { clearSettingsCache, saveSettings } from "../../src/services/settings.service";
import type { ChatSettings } from "@open-chat/types";

registerAllJobs();
export const app = createApp();

let server: Server | null = null;

// enum[] and citext[] columns parse as arrays only after this lookup, as at boot.
beforeAll(async () => {
  await initDbTypes();
  await ensureStarterCatalog(db, { includeStub: true });
  clearModelCache();
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

export const PASSWORD = "correct-horse-battery-staple";
let passwordHash: string | null = null;

export interface TestUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  token: string;
}

let counter = 0;
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${process.pid.toString(36)}${counter}`.slice(0, 38);
}

export type Role = "USER" | "ADMIN";

/** Insert an ACTIVE, verified user directly, and mint an access token for them. */
export async function createUser(over: { role?: Role; status?: "ACTIVE" | "SUSPENDED" | "BANNED"; displayName?: string; username?: string } = {}): Promise<TestUser> {
  passwordHash ??= await hashPassword(PASSWORD);
  const username = over.username ?? unique("u");
  const email = `${username}@example.com`;
  const row = await db
    .insertInto("users")
    .values({
      id: newId(),
      email,
      username,
      display_name: over.displayName ?? `User ${username}`,
      password_hash: passwordHash,
      role: over.role ?? "USER",
      status: over.status ?? "ACTIVE",
      email_verified_at: new Date(),
      ...(over.status === "SUSPENDED" ? { suspended_until: new Date(Date.now() + 86_400_000) } : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { id: row.id, email, username, displayName: row.display_name, token: signAccessToken(row.id, row.token_version) };
}

/** A supertest agent that sends the user's bearer token on every request. */
export function as(user: TestUser | null) {
  const agent = request(app);
  const auth = (r: request.Test) => (user ? r.set("Authorization", `Bearer ${user.token}`) : r);
  return {
    get: (url: string) => auth(agent.get(url)),
    post: (url: string) => auth(agent.post(url)),
    put: (url: string) => auth(agent.put(url)),
    patch: (url: string) => auth(agent.patch(url)),
    delete: (url: string) => auth(agent.delete(url)),
  };
}

export const anon = () => as(null);

// ─── Models ─────────────────────────────────────────────────────────────────

export interface StubModels {
  main: string;
  lite: string;
  image: string;
  transcribe: string;
  speech: string;
}

/** The ids of the stub provider's models (ensureStarterCatalog inserted them). */
export async function stubModels(): Promise<StubModels> {
  const rows = await db.selectFrom("models").select(["id", "model_ref"]).where("provider_id", "=", "stub").execute();
  const by = (ref: string) => rows.find((r) => r.model_ref === ref)!.id;
  return { main: by("stub-chat"), lite: by("stub-lite"), image: by("stub-image"), transcribe: by("stub-transcribe"), speech: by("stub-speech") };
}

// ─── Settings ───────────────────────────────────────────────────────────────

/** Merge a patch into the deployment settings (in-process cache cleared). */
export async function setSettings(patch: Partial<ChatSettings>): Promise<void> {
  clearSettingsCache();
  await saveSettings(patch, null);
  clearSettingsCache();
}

/** Back to the defaults. */
export async function resetSettings(): Promise<void> {
  await db.deleteFrom("settings").where("key", "=", "app").execute();
  clearSettingsCache();
}

// ─── Stubs ──────────────────────────────────────────────────────────────────

export function stubsUrl(): string {
  return process.env.STUBS_URL!;
}

export interface StubRequest {
  method: string;
  path: string;
  at: string;
  body: any;
}

/** What the stub providers received, newest first. */
export async function stubRequests(): Promise<StubRequest[]> {
  const res = await fetch(`${stubsUrl()}/__/requests`);
  return (await res.json()) as StubRequest[];
}

const isTitleCall = (r: StubRequest) => /write a title/i.test(String(r.body?.messages?.[0]?.content ?? ""));

/** Chat completion requests whose messages mention `marker` anywhere, newest first. Title calls are left out unless asked for. */
export async function chatRequestsMentioning(marker: string, opts: { includeTitles?: boolean } = {}): Promise<StubRequest[]> {
  return (await stubRequests()).filter((r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body?.messages ?? []).includes(marker) && (opts.includeTitles || !isTitleCall(r)));
}

// ─── Event streams ──────────────────────────────────────────────────────────

/** Parse a text/event-stream body into the turn events it carried (comments and retry lines skipped). */
export function parseSse(text: string): TurnEvent[] {
  const out: TurnEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) out.push(JSON.parse(data) as TurnEvent);
  }
  return out;
}

/** Buffer any response body as text (supertest does not buffer text/event-stream by itself). */
export function asText(r: request.Test): request.Test {
  return r.buffer(true).parse((res, cb) => {
    let data = "";
    res.setEncoding("utf8");
    res.on("data", (c: string) => (data += c));
    res.on("end", () => cb(null, data));
  });
}

export interface SendBody {
  content?: string;
  parentId?: string | null;
  modelId?: string;
  fileIds?: string[];
  webSearch?: boolean;
  mode?: "chat" | "image";
  aspectRatio?: string;
  projectId?: string | null;
}

/** POST a message and expect 202; returns the TurnStarted body. */
export async function send(user: TestUser, conversationId: string, body: SendBody): Promise<TurnStarted> {
  const res = await as(user).post(`/api/chats/${conversationId}/messages`).send(body);
  if (res.status !== 202) throw new Error(`send answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as TurnStarted;
}

/** Follow a turn's events (GET /api/turns/:id/events) until `done`. */
export async function followTurn(user: TestUser, turnId: string, after?: number): Promise<TurnEvent[]> {
  const res = await asText(as(user).get(`/api/turns/${turnId}/events${after !== undefined ? `?after=${after}` : ""}`)).expect(200);
  expect200Sse(res);
  return parseSse(res.body as string);
}

function expect200Sse(res: request.Response): void {
  if (!String(res.headers["content-type"]).startsWith("text/event-stream")) throw new Error(`not an event stream: ${res.headers["content-type"]}`);
}

/** Send and follow to the end. */
export async function chat(user: TestUser, content: string, opts: SendBody & { conversationId?: string } = {}): Promise<{ started: TurnStarted; events: TurnEvent[] }> {
  const { conversationId = "new", ...body } = opts;
  const started = await send(user, conversationId, { content, ...body });
  const events = await followTurn(user, started.turnId);
  return { started, events };
}

export function eventsOf<T extends TurnEvent["type"]>(events: TurnEvent[], type: T): Extract<TurnEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<TurnEvent, { type: T }>[];
}

/** A real listening server, for reading an event stream as it arrives. */
async function baseUrl(): Promise<string> {
  if (!server) {
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
  }
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Read a turn's events incrementally. Call `close()` when you stop early. */
export async function openEvents(user: TestUser, turnId: string, after = 0): Promise<{ events: AsyncGenerator<TurnEvent>; close: () => void }> {
  const controller = new AbortController();
  const res = await fetch(`${await baseUrl()}/api/turns/${turnId}/events?after=${after}`, { headers: { Authorization: `Bearer ${user.token}`, Accept: "text/event-stream" }, signal: controller.signal });
  if (res.status !== 200 || !res.body) throw new Error(`events answered ${res.status}`);
  const reader = res.body.getReader();
  async function* events(): AsyncGenerator<TurnEvent> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          for (const ev of parseSse(`${block}\n\n`)) yield ev;
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err;
    }
  }
  return { events: events(), close: () => controller.abort() };
}

// ─── Polling ────────────────────────────────────────────────────────────────

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000, everyMs = 50): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
