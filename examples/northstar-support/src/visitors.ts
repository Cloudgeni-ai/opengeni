import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Anonymous visitor isolation for the public demo.
 *
 * Every browser gets an opaque random visitor id in an HttpOnly cookie,
 * authenticated with an HMAC key generated when the process starts, so a
 * restart simply starts every visitor over. The id is not an Opengeni
 * identity: the server records which visitor created each agent session and
 * the proxy's `authorizeSession` hook lets a browser reach only those.
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
