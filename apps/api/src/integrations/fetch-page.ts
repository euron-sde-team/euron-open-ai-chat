/**
 * Fetch one web page for the open_url tool, safely (ADR 0008).
 *
 *   - the URL shape is checked (domain/net-guard.ts), then its host is resolved and every
 *     address must be public; the connection is pinned to the address that was checked,
 *     so a DNS answer that changes between the check and the connect (rebinding) cannot
 *     redirect it to an internal service;
 *   - redirects are followed by hand, at most MAX_HOPS, and every hop is checked again
 *     (the legacy chat checked once and then let fetch follow redirects anywhere);
 *   - at most MAX_BYTES are read, within TIMEOUT_MS, and only text-like content types;
 *   - the page is reduced to plain text: scripts, styles and markup are dropped.
 *
 * FETCH_ALLOW_HOSTS (development and tests only) lets the stubs host through.
 */
import dns from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { config } from "../core/config";
import { checkUrlShape, isPublicAddress } from "../domain/net-guard";

const MAX_HOPS = 4;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
export const PAGE_TEXT_CHARS = 12_000;
const TEXT_TYPES = /^(text\/(html|plain|markdown|csv)|application\/(xhtml\+xml|json|xml))/i;

export class FetchBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`fetch blocked: ${reason}`);
  }
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/** Resolve a host and insist every address is public (or the host is allowlisted). */
async function vettedAddress(host: string, allowed: boolean): Promise<{ address: string; family: number }> {
  const bare = host.replace(/^\[|\]$/g, "");
  const results = await dns.promises.lookup(bare, { all: true, verbatim: true });
  if (!results.length) throw new FetchBlockedError("DNS");
  if (!allowed && results.some((r) => !isPublicAddress(r.address))) throw new FetchBlockedError("PRIVATE_ADDRESS");
  return results[0]!;
}

export async function fetchPage(rawUrl: string, signal?: AbortSignal): Promise<FetchedPage> {
  const allowHosts = config.FETCH_ALLOW_HOSTS.map((h) => h.toLowerCase());
  let current = rawUrl;
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const shape = checkUrlShape(current, allowHosts);
    if (!shape.ok) throw new FetchBlockedError(shape.reason);
    const url = shape.url;
    const allowed = allowHosts.includes(url.hostname.toLowerCase()) || allowHosts.includes(url.host.toLowerCase());
    const target = await vettedAddress(url.hostname, allowed);

    // Pin the connection to the address we just vetted.
    const dispatcher = new Agent({
      connect: {
        lookup: (_host: string, opts: { all?: boolean }, cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => {
          if (opts?.all) cb(null, [target]);
          else cb(null, target.address, target.family);
        },
      },
      connectTimeout: 6_000,
    });
    try {
      const res = await undiciFetch(url, {
        redirect: "manual",
        signal: abort,
        dispatcher,
        headers: { "User-Agent": "OpenAIChatBot/1.0 (+https://github.com/euron-sde-team/euron-open-ai-chat)", Accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel();
        if (!loc) throw new FetchBlockedError("REDIRECT_WITHOUT_LOCATION");
        current = new URL(loc, url).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new FetchBlockedError(`HTTP_${res.status}`);
      }
      const type = res.headers.get("content-type") ?? "";
      if (!TEXT_TYPES.test(type)) {
        await res.body?.cancel();
        throw new FetchBlockedError("NOT_TEXT");
      }
      const raw = await readCapped(res.body as ReadableStream<Uint8Array> | null, MAX_BYTES);
      const isHtml = /html|xml/i.test(type);
      const title = isHtml ? decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim() ?? "") : "";
      const text = isHtml ? htmlToText(raw) : raw;
      const truncated = text.length > PAGE_TEXT_CHARS;
      return { url: url.toString(), title: title.slice(0, 200) || url.hostname, text: truncated ? text.slice(0, PAGE_TEXT_CHARS) : text, truncated };
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }
  throw new FetchBlockedError("TOO_MANY_REDIRECTS");
}

async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size >= max) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

/** Markup to readable text: scripts, styles and comments go; block tags become line breaks. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
