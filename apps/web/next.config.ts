import path from "node:path";
import type { NextConfig } from "next";

/**
 * Same-origin deployment: the browser only ever talks to this origin. In local
 * development the rewrite below proxies /api to the API; in production the load
 * balancer routes /api to the API before it reaches Next, so the refresh cookie
 * (scoped to /api/auth) stays first-party. Answers stream over Server-Sent Events
 * through the same path; the proxy passes chunks through unbuffered.
 */
const apiInternal = (process.env.API_INTERNAL_URL || "http://localhost:5036").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // One self-contained server bundle (`node apps/web/server.js`), the unit the image ships.
  output: "standalone",
  // In a monorepo the standalone trace must start at the repo root.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // The shared packages ship TypeScript source; Next compiles them in place.
  transpilePackages: ["@open-chat/ui", "@open-chat/api-client", "@open-chat/types"],
  poweredByHeader: false,
  // No floating dev badge over the app (it would also land in screenshots).
  devIndicators: false,
  reactStrictMode: true,
  // File URLs are short-lived signed URLs from the API's storage (S3 or the
  // local emulator); optimising them would cache past their expiry.
  images: { unoptimized: true },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiInternal}/api/:path*` },
    ];
  },
  // Static security headers. The Content-Security-Policy is set per request in
  // middleware.ts, because it carries a nonce and runtime media origins.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          // The microphone is for dictation in the composer, on this origin only.
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=(), fullscreen=(self)" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
