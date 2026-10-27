import { describe, expect, test } from "vitest";
import { checkUrlShape, isPublicAddress } from "../../src/domain/net-guard";

describe("isPublicAddress", () => {
  test("loopback, private, link-local, metadata, CGNAT and special ranges are refused", () => {
    for (const ip of [
      "127.0.0.1",
      "127.8.9.10",
      "10.0.0.1",
      "172.16.5.4",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "100.127.255.254",
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1",
      "192.0.2.10",
      "198.18.0.1",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  test("IPv6 loopback, unspecified, ULA, link-local and multicast are refused", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1"]) expect(isPublicAddress(ip), ip).toBe(false);
  });

  test("IPv4 smuggled inside IPv6 is judged as IPv4", () => {
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    // 6to4: 2002:AABB:CCDD:: embeds AA.BB.CC.DD
    expect(isPublicAddress("2002:0a00:0001::1")).toBe(false);
    expect(isPublicAddress("2002:a9fe:a9fe::")).toBe(false);
    expect(isPublicAddress("2002:0808:0808::1")).toBe(true);
    // NAT64 64:ff9b::/96 embeds the last 32 bits
    expect(isPublicAddress("64:ff9b::c0a8:0101")).toBe(false);
    expect(isPublicAddress("64:ff9b::7f00:1")).toBe(false);
    expect(isPublicAddress("64:ff9b::808:808")).toBe(true);
  });

  test("public IPv4 and IPv6 pass", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"]) expect(isPublicAddress(ip), ip).toBe(true);
  });

  test("garbage is not an address", () => {
    for (const s of ["", "not-an-ip", "999.1.1.1", "example.com"]) expect(isPublicAddress(s), s).toBe(false);
  });
});

describe("checkUrlShape", () => {
  test("public http(s) URLs on default ports pass", () => {
    for (const u of ["https://example.com/a?b=1", "http://example.com", "https://example.com:443/", "http://example.com:80/x", "http://8.8.8.8/", "https://[2606:4700:4700::1111]/"]) {
      const v = checkUrlShape(u);
      expect(v.ok, u).toBe(true);
    }
  });

  test("other schemes are SCHEME", () => {
    for (const u of ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "gopher://example.com", "data:text/plain,hi"]) expect(checkUrlShape(u), u).toEqual({ ok: false, reason: "SCHEME" });
  });

  test("non-default ports are PORT", () => {
    expect(checkUrlShape("http://example.com:8080/")).toEqual({ ok: false, reason: "PORT" });
    expect(checkUrlShape("https://example.com:6379/")).toEqual({ ok: false, reason: "PORT" });
  });

  test("credentials in the URL are CREDENTIALS", () => {
    expect(checkUrlShape("https://user:pass@example.com/")).toEqual({ ok: false, reason: "CREDENTIALS" });
    expect(checkUrlShape("https://user@example.com/")).toEqual({ ok: false, reason: "CREDENTIALS" });
  });

  test("localhost, .localhost, .internal and .local names are HOST", () => {
    for (const u of ["http://localhost/", "http://LOCALHOST/", "http://app.localhost/", "http://metadata.google.internal/", "http://printer.local/"]) expect(checkUrlShape(u), u).toEqual({ ok: false, reason: "HOST" });
  });

  test("literal private IPs are HOST, in any notation the URL parser normalises", () => {
    for (const u of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://10.1.2.3/", "http://[::1]/", "http://[::ffff:10.0.0.1]/", "http://2130706433/", "http://0x7f.0.0.1/", "http://100.64.1.1/"]) {
      expect(checkUrlShape(u), u).toEqual({ ok: false, reason: "HOST" });
    }
  });

  test("an unparseable URL is HOST", () => {
    expect(checkUrlShape("not a url")).toEqual({ ok: false, reason: "HOST" });
  });

  test("allowHosts lets exactly the listed host through (any port, private address or local name)", () => {
    expect(checkUrlShape("http://127.0.0.1:5129/pages/1", ["127.0.0.1"]).ok).toBe(true);
    expect(checkUrlShape("http://stubs:5129/pages/1", ["stubs"]).ok).toBe(true);
    expect(checkUrlShape("http://localhost:5129/", ["localhost"]).ok).toBe(true);
    expect(checkUrlShape("http://127.0.0.1:5129/", ["127.0.0.1:5129"]).ok).toBe(true);
    expect(checkUrlShape("http://127.0.0.2:5129/", ["127.0.0.1"])).toEqual({ ok: false, reason: "PORT" });
    expect(checkUrlShape("http://169.254.169.254/", ["127.0.0.1"])).toEqual({ ok: false, reason: "HOST" });
    // Allowlisting never permits credentials or another scheme.
    expect(checkUrlShape("http://a:b@127.0.0.1/", ["127.0.0.1"])).toEqual({ ok: false, reason: "CREDENTIALS" });
    expect(checkUrlShape("ftp://127.0.0.1/", ["127.0.0.1"])).toEqual({ ok: false, reason: "SCHEME" });
  });
});
