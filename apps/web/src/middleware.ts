import { NextResponse, type NextRequest } from "next/server";
import { mediaOrigins } from "@/lib/runtime-env";

/**
 * Per-request Content-Security-Policy with a nonce. Next reads the nonce from the
 * request's CSP header and stamps it on its own scripts; `strict-dynamic` lets those
 * load the app chunks. Origins come from the runtime environment, so one image fits
 * every deployment:
 *   MEDIA_ORIGINS  where uploads go and signed file URLs point (the S3 bucket, the local
 *                  emulator, a CDN). Uploads PUT straight to storage, so they need
 *                  connect-src; images and audio need img-src and media-src.
 * Markdown answers never render raw HTML (react-markdown without rehype-raw), and model
 * output cannot add scripts, frames or forms: the policy below is the backstop.
 */
export function buildCsp(opts: { nonce: string; dev: boolean; media: string[] }): string {
  const media = opts.media.join(" ");
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${opts.nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    // Radix positions popovers with inline styles; KaTeX sizes formulas with inline styles. Styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${media}`.trim(),
    `media-src 'self' blob: ${media}`.trim(),
    "font-src 'self' data:",
    `connect-src 'self' ${media}${opts.dev ? " ws: wss:" : ""}`.trim(),
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
  ];
  return directives.join("; ");
}

export function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp({
    nonce,
    dev: process.env.NODE_ENV !== "production",
    media: mediaOrigins(process.env.MEDIA_ORIGINS),
  });

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|env.js|icon.svg|favicon.ico).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
