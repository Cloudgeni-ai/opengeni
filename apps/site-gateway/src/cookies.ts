import { SITE_LOGIN_COOKIE, SITE_SESSION_COOKIE, SITE_VISITOR_COOKIE } from "@opengeni/contracts";
import { base64url, base64urlDecode, hmacBase64url, randomToken, timingSafeEqual } from "./crypto";

/** Short-lived proof that this visitor passed the optional Turnstile check. */
export const SITE_HUMAN_COOKIE = "__Host-og_h";

export const VISITOR_COOKIE_MAX_AGE = 180 * 24 * 60 * 60;
export const LOGIN_COOKIE_MAX_AGE = 10 * 60;
export const HUMAN_COOKIE_MAX_AGE = 60 * 60;

/** Parse a Cookie header; the first occurrence of a name wins. */
export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

/**
 * Every gateway cookie is a host-only `__Host-` cookie: Secure, Path=/, no
 * Domain, HttpOnly, SameSite=Lax (the sign-in callback is a top-level GET).
 */
export function serializeCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(maxAge))}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearCookie(name: string): string {
  return serializeCookie(name, "", 0);
}

/** `<payload>.<mac>`; the purpose separates cookie MACs from each other and from request signatures. */
async function signValue(secret: string, purpose: string, payload: string): Promise<string> {
  return `${payload}.${await hmacBase64url(secret, `og-cookie\n${purpose}\n${payload}`)}`;
}

async function verifyValue(secret: string, purpose: string, value: string): Promise<string | null> {
  const index = value.lastIndexOf(".");
  if (index <= 0) return null;
  const payload = value.slice(0, index);
  const expected = await hmacBase64url(secret, `og-cookie\n${purpose}\n${payload}`);
  return timingSafeEqual(value.slice(index + 1), expected) ? payload : null;
}

// ---------------------------------------------------------------------------
// Visitor
// ---------------------------------------------------------------------------

const VISITOR_ID = /^[A-Za-z0-9_-]{22}$/u;

/** A new random 128-bit visitor id and its signed cookie. */
export async function mintVisitor(secret: string): Promise<{ id: string; setCookie: string }> {
  const id = randomToken(16);
  return {
    id,
    setCookie: serializeCookie(
      SITE_VISITOR_COOKIE,
      await signValue(secret, "visitor", id),
      VISITOR_COOKIE_MAX_AGE,
    ),
  };
}

/** The verified visitor id, or null when absent or forged. */
export async function readVisitor(
  secret: string,
  cookies: Map<string, string>,
): Promise<string | null> {
  const value = cookies.get(SITE_VISITOR_COOKIE);
  if (!value) return null;
  const id = await verifyValue(secret, "visitor", value);
  return id && VISITOR_ID.test(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Site session (opaque token minted by the API)
// ---------------------------------------------------------------------------

const SESSION_TOKEN = /^[A-Za-z0-9._~-]{32,512}$/u;

export function readSession(cookies: Map<string, string>): string | null {
  const value = cookies.get(SITE_SESSION_COOKIE);
  return value && SESSION_TOKEN.test(value) ? value : null;
}

export function isSessionToken(value: unknown): value is string {
  return typeof value === "string" && SESSION_TOKEN.test(value);
}

export function sessionCookie(token: string, maxAge: number): string {
  return serializeCookie(SITE_SESSION_COOKIE, token, maxAge);
}

// ---------------------------------------------------------------------------
// Sign-in state (state + PKCE verifier + return path, bound to the host)
// ---------------------------------------------------------------------------

export type LoginState = {
  state: string;
  verifier: string;
  returnPath: string;
  host: string;
  expiresAt: number;
};

export async function loginCookie(secret: string, login: LoginState): Promise<string> {
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({
        s: login.state,
        v: login.verifier,
        r: login.returnPath,
        h: login.host,
        e: login.expiresAt,
      }),
    ),
  );
  return serializeCookie(
    SITE_LOGIN_COOKIE,
    await signValue(secret, "login", payload),
    LOGIN_COOKIE_MAX_AGE,
  );
}

export async function readLogin(
  secret: string,
  cookies: Map<string, string>,
  now = Date.now(),
): Promise<LoginState | null> {
  const value = cookies.get(SITE_LOGIN_COOKIE);
  if (!value) return null;
  const payload = await verifyValue(secret, "login", value);
  const bytes = payload ? base64urlDecode(payload) : null;
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (
      typeof parsed.s !== "string" ||
      typeof parsed.v !== "string" ||
      typeof parsed.r !== "string" ||
      typeof parsed.h !== "string" ||
      typeof parsed.e !== "number" ||
      parsed.e < now
    )
      return null;
    return {
      state: parsed.s,
      verifier: parsed.v,
      returnPath: parsed.r,
      host: parsed.h,
      expiresAt: parsed.e,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Human check (optional Turnstile)
// ---------------------------------------------------------------------------

/** Proof bound to the Site host and the visitor, so it is never valid on another Site. */
export async function humanCookie(
  secret: string,
  host: string,
  visitor: string,
  now = Date.now(),
): Promise<string> {
  const expiresAt = Math.floor(now / 1000) + HUMAN_COOKIE_MAX_AGE;
  return serializeCookie(
    SITE_HUMAN_COOKIE,
    await signValue(secret, "human", `${host.toLowerCase()}~${visitor}~${expiresAt}`),
    HUMAN_COOKIE_MAX_AGE,
  );
}

/** True when the human cookie is valid, unexpired and minted for this host and visitor. */
export async function readHuman(
  secret: string,
  cookies: Map<string, string>,
  host: string,
  visitor: string | null,
  now = Date.now(),
): Promise<boolean> {
  const value = cookies.get(SITE_HUMAN_COOKIE);
  if (!value || !visitor) return false;
  const payload = await verifyValue(secret, "human", value);
  if (!payload) return false;
  const [boundHost, id, expiresAt] = payload.split("~");
  return (
    boundHost === host.toLowerCase() && id === visitor && Number(expiresAt) > Math.floor(now / 1000)
  );
}

// ---------------------------------------------------------------------------
// Form tokens (CSRF): bound to the purpose, host and visitor; short-lived
// ---------------------------------------------------------------------------

export async function formToken(
  secret: string,
  purpose: string,
  host: string,
  visitor: string,
  now = Date.now(),
): Promise<string> {
  const expiresAt = Math.floor(now / 1000) + 60 * 60;
  return await signValue(secret, `form:${purpose}`, `${expiresAt}~${host}~${visitor}`);
}

export async function verifyFormToken(
  secret: string,
  purpose: string,
  token: string,
  host: string,
  visitor: string | null,
  now = Date.now(),
): Promise<boolean> {
  if (!visitor) return false;
  const payload = await verifyValue(secret, `form:${purpose}`, token);
  if (!payload) return false;
  const [expiresAt, boundHost, boundVisitor] = payload.split("~");
  return (
    boundHost === host && boundVisitor === visitor && Number(expiresAt) > Math.floor(now / 1000)
  );
}
