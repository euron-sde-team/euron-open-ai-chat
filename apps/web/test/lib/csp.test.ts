import { describe, expect, it } from "vitest";
import { buildCsp } from "@/middleware";
import { mediaOrigins, serverEnv } from "@/lib/runtime-env";

describe("content security policy", () => {
  it("is strict by default, adds the storage origins and allows no frames", () => {
    const csp = buildCsp({ nonce: "abc", dev: false, media: ["https://media.example.org"] });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("img-src 'self' data: blob: https://media.example.org");
    expect(csp).toContain("media-src 'self' blob: https://media.example.org");
    expect(csp).toContain("connect-src 'self' https://media.example.org");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/(media|connect)-src[^;]* https:(;| )/);
  });
  it("allows eval and websockets for the dev server only", () => {
    expect(buildCsp({ nonce: "n", dev: true, media: [] })).toContain("'unsafe-eval'");
    expect(buildCsp({ nonce: "n", dev: false, media: [] })).not.toContain("ws:");
  });
  it("parses media origins and drops anything that is not an origin", () => {
    expect(mediaOrigins("http://localhost:4566, https://cdn.example.org/ ,javascript:x,https://a.example/path")).toEqual(["http://localhost:4566", "https://cdn.example.org"]);
    expect(mediaOrigins(undefined)).toEqual([]);
  });
});

describe("runtime env", () => {
  it("reads the container environment with defaults", () => {
    expect(serverEnv({})).toEqual({ productName: "Euron Open AI Chat", apiUrl: "/api" });
    expect(serverEnv({ PRODUCT_NAME: " Acme Assistant ", PUBLIC_API_URL: "https://api.example.org/api" })).toMatchObject({ productName: "Acme Assistant", apiUrl: "https://api.example.org/api" });
  });
});
