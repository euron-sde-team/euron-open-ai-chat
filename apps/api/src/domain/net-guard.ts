/**
 * Which addresses an outbound fetch made on a user's behalf (the open_url tool) may
 * reach. Pure, so every rule is unit-tested (ADR 0008).
 *
 * Only public unicast addresses pass. Refused: loopback, private (RFC 1918, ULA),
 * link-local (including the cloud metadata service at 169.254.169.254), carrier-grade
 * NAT, multicast, broadcast, documentation and benchmark ranges, unspecified addresses,
 * and IPv4 smuggled inside IPv6 (::ffff:10.0.0.1, 6to4, NAT64) which is unwrapped and
 * judged as IPv4.
 */
import ipaddr from "ipaddr.js";

export function isPublicAddress(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return false;
  }
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return isPublicAddress(v6.toIPv4Address().toString());
    const range = v6.range();
    // 6to4 (2002::/16) and NAT64 (64:ff9b::/96) embed an IPv4 address: judge that.
    if (range === "6to4") {
      const p = v6.parts;
      return isPublicAddress(`${p[1]! >> 8}.${p[1]! & 255}.${p[2]! >> 8}.${p[2]! & 255}`);
    }
    if (range === "rfc6052") {
      const p = v6.parts;
      return isPublicAddress(`${p[6]! >> 8}.${p[6]! & 255}.${p[7]! >> 8}.${p[7]! & 255}`);
    }
    return range === "unicast";
  }
  return (addr as ipaddr.IPv4).range() === "unicast";
}

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: "SCHEME" | "PORT" | "CREDENTIALS" | "HOST" };

/** The shape checks that need no DNS: http(s) only, default ports only, no user:pass@, a real host name. */
export function checkUrlShape(raw: string, allowHosts: readonly string[] = []): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "HOST" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "SCHEME" };
  if (url.username || url.password) return { ok: false, reason: "CREDENTIALS" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = allowHosts.includes(host) || allowHosts.includes(url.host.toLowerCase());
  if (url.port && url.port !== "80" && url.port !== "443" && !allowed) return { ok: false, reason: "PORT" };
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    if (!allowed) return { ok: false, reason: "HOST" };
  }
  // A literal IP must itself be public (no DNS step will catch it otherwise).
  if (ipaddr.isValid(host) && !isPublicAddress(host) && !allowed) return { ok: false, reason: "HOST" };
  return { ok: true, url };
}
