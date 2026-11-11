import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Anonymous visitor isolation for the public demo.
 *
 * Every browser gets an opaque random visitor id in an HttpOnly cookie,
 * authenticated with an HMAC key generated when the process starts, so a
 * restart simply starts every visitor over. The id is not an Opengeni
 * identity: the server records which visitor created each agent session and
 * the proxy's `authorizeSession` hook lets a browser reach only those. Each
 * session's MCP server carries a separately signed binding to the same
 * visitor, which selects whose product data the agent's tools use.
 */

const COOKIE_NAME = "northstar_visitor";
// `__Host-` cookies must be Secure, host-only and Path=/, so a sibling
// subdomain cannot plant (fixate) a visitor id on this host.
const SECURE_COOKIE_NAME = `__Host-${COOKIE_NAME}`;
const VISITOR_ID = /^[A-Za-z0-9_-]{22}$/;
const MAX_TRACKED_SESSIONS = 10_000;

export type IssuedVisitor = {
  id: string;
  /** The `Set-Cookie` header value that establishes this visitor. */
  setCookie: string;
};

export class VisitorCookies {
  readonly #key = randomBytes(32);
  readonly #httpsOrigin: boolean;

  /** `appOrigin` is the product's public origin; an https origin (or request) gets Secure cookies. */
  constructor(appOrigin: string) {
    this.#httpsOrigin = isHttps(appOrigin);
  }

  /** The verified visitor id, or null when the cookie is missing, malformed, or not signed by this process. */
  read(request: Request): string | null {
    const name = this.#secure(request) ? SECURE_COOKIE_NAME : COOKIE_NAME;
    for (const value of cookieValues(request.headers.get("cookie"), name)) {
      const parts = value.split(".");
      if (parts.length !== 2) continue;
      const [id, mac] = parts as [string, string];
      if (VISITOR_ID.test(id) && sameText(mac, this.#sign(id))) return id;
    }
    return null;
  }

  /** A new visitor. The cookie lasts for the browser session: visitor state lives only in this process. */
  issue(request: Request): IssuedVisitor {
    const id = randomBytes(16).toString("base64url");
    const secure = this.#secure(request);
    const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", ...(secure ? ["Secure"] : [])];
    return {
      id,
      setCookie: `${secure ? SECURE_COOKIE_NAME : COOKIE_NAME}=${id}.${this.#sign(id)}; ${attributes.join("; ")}`,
    };
  }

  /**
   * A server-only value that ties the MCP calls of one visitor's agent sessions
   * to that visitor. It travels only in the session's MCP server headers, which
   * Opengeni stores encrypted and never returns to the browser or the model.
   */
  mcpBinding(visitorId: string): string {
    return `${visitorId}.${this.#sign(`mcp:${visitorId}`)}`;
  }

  /** The visitor an MCP binding names, or null when it is missing, malformed, or not signed by this process. */
  readMcpBinding(value: string | null): string | null {
    const parts = value?.split(".") ?? [];
    if (parts.length !== 2) return null;
    const [id, mac] = parts as [string, string];
    return VISITOR_ID.test(id) && sameText(mac, this.#sign(`mcp:${id}`)) ? id : null;
  }

  #secure(request: Request): boolean {
    return this.#httpsOrigin || isHttps(request.url);
  }

  #sign(id: string): string {
    return createHmac("sha256", this.#key).update(id).digest("base64url");
  }
}

/** Which visitor created each agent session: the only session access a browser ever gets. */
export class SessionOwners {
  readonly #owners = new Map<string, string>();

  constructor(readonly maxSessions = MAX_TRACKED_SESSIONS) {}

  /** Record `visitorId` as the creator. False when another visitor already owns the session. */
  claim(sessionId: string, visitorId: string): boolean {
    const owner = this.#owners.get(sessionId);
    if (owner !== undefined) return owner === visitorId;
    this.#owners.set(sessionId, visitorId);
    // Bounded memory: the oldest runs become unreachable first.
    if (this.#owners.size > this.maxSessions) {
      this.#owners.delete(this.#owners.keys().next().value!);
    }
    return true;
  }

  /** True only for the visitor that created the session; unknown sessions and visitors are denied. */
  owns(sessionId: string, visitorId: string | null): boolean {
    return visitorId !== null && this.#owners.get(sessionId) === visitorId;
  }
}

/**
 * The client address in a header a trusted reverse proxy sets: the last entry
 * of a comma-separated list such as `X-Forwarded-For` (the hop the proxy
 * itself appended), or the whole value of a single-address header such as
 * `X-Real-IP`. Null when the header is missing or malformed.
 */
export function forwardedClientAddress(value: string | null): string | null {
  const address = value?.split(",").at(-1)?.trim() ?? "";
  return /^[0-9A-Fa-f:.]{2,45}$/.test(address) ? address : null;
}

/**
 * The network a client address belongs to, for the per-network limits: an IPv4
 * address as is (also when written as an IPv4-mapped IPv6 address), and an
 * IPv6 address as its /64, the block one subscriber usually holds.
 */
export function networkKey(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (!address.includes(":")) return address;
  const halves = address.toLowerCase().split("%")[0]!.split("::");
  if (halves.length > 2) return address;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 2
      ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail]
      : head;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** True when two secrets match, compared in constant time. */
export function sameSecret(actual: string | null, expected: string): boolean {
  return actual !== null && expected.length > 0 && sameText(actual, expected);
}

/** True for same-origin browser requests and non-browser clients (which send no `Sec-Fetch-Site`). */
export function sameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function* cookieValues(header: string | null, name: string): Generator<string> {
  for (const pair of header?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      yield pair.slice(separator + 1).trim();
    }
  }
}

function sameText(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
