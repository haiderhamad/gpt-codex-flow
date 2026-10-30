import type { GcfConfig } from "./config.js";
import { readRuntimeConnection } from "./profileStore.js";

/**
 * HTTP Origin protection for browser-originated requests.
 *
 * A missing Origin header is normal for many server-to-server MCP clients.
 * Origin is only a CSRF/DNS-rebinding signal, NOT authentication or a
 * replacement for checking Host, bearer credentials, and OAuth principals.
 */
function canonicalOrigin(value: string, allowLoopbackHttp = true): string | null {
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol !== "https:" && !(allowLoopbackHttp && loopback && url.protocol === "http:")) return null;
    if (value !== url.origin) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function configuredHttpOrigins(config: GcfConfig): readonly string[] {
  const candidates = [
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    `http://[::1]:${config.port}`
  ];

  const runtime = readRuntimeConnection(config.defaultRoot);
  if (runtime.endpoint) {
    try {
      candidates.push(new URL(runtime.endpoint).origin);
    } catch {
      // Ignore a malformed runtime endpoint; it grants no extra origin.
    }
  }
  const explicit = process.env.GCF_HTTP_ALLOWED_ORIGINS?.trim();
  if (explicit) {
    for (const value of explicit.split(",")) {
      const origin = value.trim();
      if (!canonicalOrigin(origin, true)) {
        throw new Error("GCF_HTTP_ALLOWED_ORIGINS must contain only exact origins (HTTPS or loopback HTTP), no wildcards or paths.");
      }
      candidates.push(origin);
    }
  }

  return Object.freeze([...new Set(candidates.map(value => canonicalOrigin(value)).filter(
    (item): item is string => item !== null
  ))]);
}

/** Browser Origin absent => non-browser client: bearer checks still apply. */
export function isAllowedHttpOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return true;
  const parsed = canonicalOrigin(origin);
  return parsed !== null && allowed.includes(parsed);
}

/** Tokenless local HTTP must not answer an attacker-controlled DNS hostname.
 * Compare the raw Host authority; URL parsing would normalize malformed input.
 * Forwarded headers never confer permission.
 */
export function isAllowedTokenlessHost(host: string | undefined, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof host !== "string") return false;
  const authorities = ["127.0.0.1", "localhost", "[::1]"];
  return authorities.some(name => host === `${name}:${port}` || (port === 80 && host === name));
}
