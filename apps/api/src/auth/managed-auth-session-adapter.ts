import type {
  ManagedAuthResolvedSession,
  ManagedAuthSessionAdapter,
} from "@opengeni/core/managed-auth-session-sets";
import { sql } from "drizzle-orm";
import type { Database } from "@opengeni/db";
import type { ManagedAuth } from "@opengeni/core";
import { createHmac, timingSafeEqual } from "node:crypto";
import { runManagedAuthAttempt } from "./managed-auth-attempt-context";

export function createBetterAuthSessionAdapter(
  auth: ManagedAuth,
  db: Database,
): ManagedAuthSessionAdapter {
  return {
    async authenticate(input) {
      if (input.provider !== "email_password") {
        throw new Error("unsupported managed authentication provider");
      }
      const result = await runManagedAuthAttempt(
        input.transactionId,
        async () =>
          await auth.api.signInEmail({
            body: {
              email: input.credentials.email,
              password: input.credentials.password,
              rememberMe: true,
            },
            headers: input.headers,
            returnHeaders: true,
          }),
      );
      const token = result.response?.token;
      if (typeof token !== "string") {
        throw new Error("managed authentication did not create an isolated session");
      }
      const resolved = await (await auth.$context).internalAdapter.findSession(token);
      if (!resolved?.session?.id) {
        throw new Error("managed authentication session could not be resolved");
      }
      return { authSessionId: resolved.session.id };
    },

    async resolveSelectedSession(input): Promise<ManagedAuthResolvedSession | null> {
      const resolved = await (await auth.$context).internalAdapter.findSession(input.token);
      return liveResolvedSession(resolved);
    },

    async resolveAmbientSession(headers): Promise<ManagedAuthResolvedSession | null> {
      const context = await auth.$context;
      const signed = cookieValue(headers.get("cookie"), context.authCookies.sessionToken.name);
      const token = signed ? verifiedSignedCookieValue(signed, context.secret) : null;
      if (!token) return null;
      const resolved = await context.internalAdapter.findSession(token);
      return liveResolvedSession(resolved);
    },

    async refreshSelectedSession(input): Promise<ManagedAuthResolvedSession | null> {
      const context = await auth.$context;
      const cookie = context.authCookies.sessionToken;
      const headers = new Headers({
        cookie: `${cookie.name}=${signedCookieValue(input.token, context.secret)}`,
      });
      const resolved = await auth.api.getSession({ headers, returnHeaders: true });
      if (!resolved.response) return null;
      // The provider may renew its durable expiry and emit token/cache cookies;
      // this server-side selected-slot resolution intentionally discards them.
      return resolved.response as ManagedAuthResolvedSession;
    },

    async revokeSession(input) {
      await db.execute(sql`delete from auth_sessions where id = ${input.authSessionId}`);
    },

    async createLegacySelectedSessionCookies(input, currentCookieHeader) {
      const context = await auth.$context;
      const cookie = context.authCookies.sessionToken;
      const value = input ? signedCookieValue(input.token, context.secret) : "";
      const headers = [
        serializeCookieHeader(cookie.name, value, {
          ...cookie.attributes,
          ...(input ? {} : { maxAge: 0, expires: new Date(0) }),
        }),
      ];
      for (const cacheCookie of [
        context.authCookies.sessionData,
        context.authCookies.accountData,
        context.authCookies.dontRememberToken,
      ]) {
        for (const name of cacheCookieNames(cacheCookie.name, currentCookieHeader)) {
          headers.push(
            serializeCookieHeader(name, "", {
              ...cacheCookie.attributes,
              maxAge: 0,
              expires: new Date(0),
            }),
          );
        }
      }
      return headers;
    },
  };
}

function liveResolvedSession(value: unknown): ManagedAuthResolvedSession | null {
  if (!value || typeof value !== "object") return null;
  const session = (value as { session?: { expiresAt?: unknown } }).session;
  const expiresAt = session?.expiresAt;
  const expiryMillis =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : typeof expiresAt === "string" || typeof expiresAt === "number"
        ? new Date(expiresAt).getTime()
        : Number.NaN;
  if (!Number.isFinite(expiryMillis) || expiryMillis <= Date.now()) return null;
  return value as ManagedAuthResolvedSession;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

function verifiedSignedCookieValue(value: string, secret: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  const separator = decoded.lastIndexOf(".");
  if (separator <= 0) return null;
  const token = decoded.slice(0, separator);
  const signature = decoded.slice(separator + 1);
  const expected = createHmac("sha256", secret).update(token, "utf8").digest("base64");
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
    ? token
    : null;
}

function signedCookieValue(value: string, secret: string): string {
  return encodeURIComponent(
    `${value}.${createHmac("sha256", secret).update(value, "utf8").digest("base64")}`,
  );
}

function serializeCookieHeader(
  name: string,
  value: string,
  attributes: {
    domain?: string;
    expires?: Date;
    httpOnly?: boolean;
    maxAge?: number;
    path?: string;
    partitioned?: boolean;
    prefix?: "secure" | "host";
    sameSite?: string;
    secure?: boolean;
  },
): string {
  let cookieName = name;
  if (attributes.prefix === "secure" && !cookieName.startsWith("__Secure-")) {
    cookieName = `__Secure-${cookieName}`;
  } else if (attributes.prefix === "host" && !cookieName.startsWith("__Host-")) {
    cookieName = `__Host-${cookieName}`;
  }
  if (cookieName.startsWith("__Secure-")) attributes.secure = true;
  if (cookieName.startsWith("__Host-")) {
    attributes.secure = true;
    attributes.path = "/";
    delete attributes.domain;
  }
  let header = `${cookieName}=${value}`;
  if (attributes.maxAge !== undefined)
    header += `; Max-Age=${Math.max(0, Math.floor(attributes.maxAge))}`;
  if (attributes.domain) header += `; Domain=${attributes.domain}`;
  if (attributes.path) header += `; Path=${attributes.path}`;
  if (attributes.expires) header += `; Expires=${attributes.expires.toUTCString()}`;
  if (attributes.httpOnly) header += "; HttpOnly";
  if (attributes.secure) header += "; Secure";
  if (attributes.sameSite) {
    header += `; SameSite=${attributes.sameSite[0]?.toUpperCase()}${attributes.sameSite.slice(1)}`;
  }
  if (attributes.partitioned) header += "; Partitioned";
  return header;
}

function cacheCookieNames(baseName: string, cookieHeader?: string | null): string[] {
  const names = new Set([baseName]);
  for (const part of cookieHeader?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name === baseName || name.startsWith(`${baseName}.`)) names.add(name);
  }
  return [...names].sort();
}
