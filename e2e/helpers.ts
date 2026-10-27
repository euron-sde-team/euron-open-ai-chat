/**
 * Shared helpers for the end-to-end suite. Setup goes through the real REST API (never
 * the database) so each test spends browser time only on the behaviour under test.
 *
 * Every simulated person gets their own client address (X-Forwarded-For, honoured by the
 * local stack's single trusted proxy hop), on API calls and on their browser's API calls,
 * so the per-IP budgets (sign-in, sign-up) apply per person the way they would for real
 * visitors instead of every test sharing one loopback budget.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

export const WEB = (process.env.E2E_BASE_URL || "http://localhost:3540").replace(/\/+$/, "");
export const API = (process.env.E2E_API_URL || "http://localhost:5036/api").replace(/\/+$/, "");
export const MAILPIT = (process.env.E2E_MAILPIT_URL || "http://localhost:8056").replace(/\/+$/, "");
export const STUBS = (process.env.E2E_STUBS_URL || "http://localhost:5129").replace(/\/+$/, "");

/** The demo password `make env` generated (E2E_DEMO_PASSWORD overrides). Never hardcoded. */
export function demoPassword(): string {
  if (process.env.E2E_DEMO_PASSWORD) return process.env.E2E_DEMO_PASSWORD;
  const file = path.join(__dirname, "..", "deploy", "compose", ".env");
  const line = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("CHAT_DEMO_PASSWORD=")) : undefined;
  if (!line) throw new Error("No demo password: run `make env && make demo`, or set E2E_DEMO_PASSWORD");
  return line.slice("CHAT_DEMO_PASSWORD=".length).trim().replace(/^["']|["']$/g, "");
}

/** Demo accounts (apps/api/src/demo/seed.ts). */
export const DEMO = {
  admin: "admin@example.com",
  priya: "priya.nair@example.com",
  leo: "leo.marquez@example.com",
};

export interface TestUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  password: string;
  accessToken: string;
  /** The simulated client address this person uses. */
  ip: string;
}

const run = randomBytes(3).toString("hex");
let seq = 0;

/** A unique suffix for names, slugs and addresses (lowercase letters and digits). */
export function uniq(prefix = "e2e"): string {
  seq += 1;
  return `${prefix}${run}${seq}${randomBytes(2).toString("hex")}`;
}

// Addresses in 10.0.0.0/8: a random starting point per worker, then sequential, so no two
// simulated people in a run (or, in practice, in back-to-back runs) share a budget.
let nextIp = randomBytes(3).readUIntBE(0, 3) & 0xffffff;

/** A fresh client address for one simulated person. */
export function clientIp(): string {
  nextIp = (nextIp + 1) & 0xffffff;
  return `10.${(nextIp >> 16) & 255}.${(nextIp >> 8) & 255}.${nextIp & 255}`;
}

type Json = Record<string, unknown>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Calls the API as `who` (a token, or nobody), failing the test on an unexpected status. */
export async function call<T = Json>(
  request: APIRequestContext,
  method: Method,
  route: string,
  opts: { token?: string; ip?: string; data?: unknown; expect?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { "X-Forwarded-For": opts.ip ?? clientIp() };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await request.fetch(`${API}${route}`, { method, headers, data: opts.data as never, maxRedirects: 0 });
  const text = await r.text();
  if (opts.expect !== undefined) expect(r.status(), `${method} ${route}: ${text}`).toBe(opts.expect);
  else expect(r.ok(), `${method} ${route} -> ${r.status()}: ${text}`).toBe(true);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return {} as T;
  }
}

/** Calls the API as a test user. */
export function as<T = Json>(request: APIRequestContext, user: Pick<TestUser, "accessToken" | "ip">, method: Method, route: string, data?: unknown, status?: number) {
  return call<T>(request, method, route, { token: user.accessToken, ip: user.ip, data, expect: status });
}

// ─── Mail ────────────────────────────────────────────────────────────────────

interface MailSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Created: string;
}

/** The newest mail to `to` matching `subject`, polling Mailpit until it arrives. */
export async function waitForMail(request: APIRequestContext, to: string, subject: RegExp = /./, timeoutMs = 30_000): Promise<{ html: string; text: string; subject: string }> {
  const addr = to.toLowerCase();
  let found: { html: string; text: string; subject: string } | null = null;
  await expect
    .poll(
      async () => {
        const r = await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${addr}"`)}&limit=20`);
        if (!r.ok()) return false;
        const list = ((await r.json()).messages ?? []) as MailSummary[];
        const hit = list.find((m) => m.To.some((t) => t.Address.toLowerCase() === addr) && subject.test(m.Subject));
        if (!hit) return false;
        const full = await (await request.get(`${MAILPIT}/api/v1/message/${hit.ID}`)).json();
        found = { html: full.HTML || "", text: full.Text || "", subject: hit.Subject };
        return true;
      },
      { timeout: timeoutMs, intervals: [250], message: `mail to ${to} matching ${subject}` },
    )
    .toBe(true);
  return found!;
}

/** The first link in a mail matching `pattern`, with HTML entities undone. */
export function linkIn(mail: { html: string; text: string }, pattern: RegExp): string {
  const m = `${mail.text}\n${mail.html}`.replace(/&amp;/g, "&").match(pattern);
  if (!m) throw new Error(`No link matching ${pattern} in the mail`);
  return m[0];
}

/** The verification link the API mailed to `email`. */
export async function verificationLink(request: APIRequestContext, email: string): Promise<string> {
  return linkIn(await waitForMail(request, email, /confirm|verify/i), /https?:\/\/[^\s"'<>]+\/verify-email\?token=[^\s"'<>]+/);
}

// ─── People ──────────────────────────────────────────────────────────────────

/** A fresh, verified account: signs up through the API and confirms the mailed link (when verification is on). */
export async function newUser(request: APIRequestContext, opts: { displayName?: string } = {}): Promise<TestUser> {
  const username = uniq("u");
  const email = `${username}@example.com`;
  const password = `Pw-${randomBytes(9).toString("base64url")}`;
  const displayName = opts.displayName ?? `Tester ${username.slice(-6)}`;
  const ip = clientIp();
  const signup = await call<{ verificationRequired?: boolean; accessToken?: string; user?: { id: string } }>(request, "POST", "/auth/signup", { ip, data: { email, username, displayName, password } });
  if (signup.accessToken && signup.user) return { id: signup.user.id, email, username, displayName, password, accessToken: signup.accessToken, ip };
  expect(signup.verificationRequired).toBe(true);
  const token = decodeURIComponent(new URL(await verificationLink(request, email)).searchParams.get("token") ?? "");
  const auth = await call<{ accessToken: string; user: { id: string } }>(request, "POST", "/auth/verify-email", { ip, data: { token } });
  return { id: auth.user.id, email, username, displayName, password, accessToken: auth.accessToken, ip };
}

const staffCache = new Map<string, Promise<TestUser>>();

/** Signs an existing account in through the API (demo users, or a fresh token). */
export async function apiLogin(request: APIRequestContext, login: string, password = demoPassword()): Promise<TestUser> {
  const ip = clientIp();
  const r = await call<{ accessToken: string; user: { id: string; email: string; username: string; displayName: string } }>(request, "POST", "/auth/login", { ip, data: { login, password } });
  return { id: r.user.id, email: r.user.email, username: r.user.username, displayName: r.user.displayName, password, accessToken: r.accessToken, ip };
}

/** A demo account, signed in once per worker (access tokens outlive a spec). */
export function demo(request: APIRequestContext, login: string): Promise<TestUser> {
  let p = staffCache.get(login);
  if (!p) {
    p = apiLogin(request, login);
    staffCache.set(login, p);
    p.catch(() => staffCache.delete(login));
  }
  return p;
}

/**
 * A browser context that presents itself from `ip` to the API (which keeps per-IP
 * budgets). Routed per request rather than set as an extra header on every request: an
 * extra header would also go to presigned uploads.
 */
export async function newContext(browser: Browser, ip: string = clientIp()): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.route(`${WEB}/api/**`, (route) => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": ip } }));
  return ctx;
}

/**
 * Signs in through the UI login form and waits until the form has sent the browser on
 * (the session is in place by then; not every destination has the avatar menu).
 */
export async function signIn(page: Page, user: Pick<TestUser, "email" | "password">, opts: { next?: string } = {}) {
  await page.goto(opts.next ? `/login?next=${encodeURIComponent(opts.next)}` : "/login");
  await page.locator("#login").fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.getByTestId("login-submit").click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** A new browser context (a device with its own address) for `user`, signed in through the UI. */
export async function pageFor(browser: Browser, user: TestUser, next?: string): Promise<Page> {
  const ctx = await newContext(browser, user.ip);
  const page = await ctx.newPage();
  await signIn(page, user, { next });
  return page;
}

export async function signOut(page: Page) {
  await page.getByTestId("account-menu").first().click();
  await page.getByTestId("sign-out").click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByTestId("account-menu")).toHaveCount(0);
}

/** Send a message from the composer and wait until the answer has finished streaming. */
export async function send(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/c\/[0-9A-Z]{26}$/);
  await waitForAnswer(page);
}

/** Wait until no answer is streaming (the stop button is gone and the last answer is not busy). */
export async function waitForAnswer(page: Page, timeout = 60_000) {
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout });
  await expect(page.locator('[data-testid="assistant-message"][aria-busy="true"]')).toHaveCount(0, { timeout });
}

/** A small, valid PNG (a solid colour square), built in memory: no binary fixture to commit. */
export function pngBytes(size = 16, rgb: [number, number, number] = [37, 99, 235]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
