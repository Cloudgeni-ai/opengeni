import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { Database } from "@opengeni/db";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { sql } from "drizzle-orm";

import {
  requestSourceRateLimitKey,
  TRUSTED_CLIENT_ADDRESS_HEADER,
  UNKNOWN_REQUEST_SOURCE_ADDRESS,
} from "../http/request-source";

export type ManagedAuthClientRateLimitRule = { window: number; max: number };

/**
 * Better Auth's per-client-address limits, keyed by endpoint path relative to
 * `/v1/auth`. The client address is the trusted source address stamped by the
 * API (see `TRUSTED_CLIENT_ADDRESS_HEADER`), never a caller-supplied header.
 *
 * Better Auth keys each counter on `(client address, path)` and resets it only
 * after `window` seconds pass without an admitted request. Its database store
 * prunes rows idle for longer than 60 s, so no window here exceeds 60 s; a
 * longer window would silently shrink to that pruning horizon. The limits are
 * sized for launch traffic that shares one address (office and carrier NAT)
 * while bounding scripted credential guessing and mail sending from one
 * source. Per-email throttles below cap the same abuse across many addresses.
 *
 * Email sign-in and sign-up allow 20 per minute, at least Better Auth's
 * previous default (3 per 10 s, about 18 per minute). Until the edge forwards
 * real client addresses (for example ingress-nginx behind a cloud load
 * balancer with `externalTrafficPolicy: Cluster`), every user shares a few
 * node addresses, and these two limits then bound the whole deployment's
 * email sign-in and sign-up rate; they must not fall below that default.
 */
export const MANAGED_AUTH_CLIENT_RATE_LIMIT_RULES = {
  "/sign-in/email": { window: 60, max: 20 },
  "/sign-up/email": { window: 60, max: 20 },
  "/sign-in/social": { window: 60, max: 20 },
  "/callback/*": { window: 60, max: 30 },
  "/request-password-reset": { window: 60, max: 5 },
  "/send-verification-email": { window: 60, max: 5 },
  "/verify-email": { window: 60, max: 20 },
  "/reset-password": { window: 60, max: 10 },
  "/reset-password/*": { window: 60, max: 20 },
} as const satisfies Record<string, ManagedAuthClientRateLimitRule>;

export type ManagedAuthEmailThrottle = {
  purpose: "sign_in" | "sign_up" | "password_reset" | "verification_email";
  windowSeconds: number;
  /** Attempts one client address (an IPv6 /64) may make against one email. */
  perSourceMax: number;
  /** Attempts all client addresses together may make against one email. */
  perEmailMax: number;
};

/**
 * Per-email throttles for the endpoints that verify a password or send mail
 * to an address. They bound password guessing against one account and mail
 * bombing of one inbox regardless of how many client addresses an attacker
 * rotates through. Every attempt counts, including successful sign-ins.
 *
 * Each email has two fixed windows. The tight one is per (email, client
 * address); an attempt it refuses never reaches the looser per-email window.
 * One source can therefore spend only its own share of an email's budget:
 * locking a person out of email/password sign-in, sign-up, password reset, or
 * verification mail takes at least `perEmailMax / perSourceMax` (5) distinct
 * client addresses (IPv6: /64 blocks) inside the window, while one address
 * can exhaust that email's budget only for requests from the same address.
 * Social sign-in is never throttled per email. The accepted cost is that a
 * distributed attacker may make up to `perEmailMax` attempts per window
 * against one email, and can deny that email's password sign-in for the rest
 * of the window once it spends them.
 */
export const MANAGED_AUTH_EMAIL_THROTTLES = {
  "/sign-in/email": {
    purpose: "sign_in",
    windowSeconds: 15 * 60,
    perSourceMax: 10,
    perEmailMax: 50,
  },
  "/sign-up/email": {
    purpose: "sign_up",
    windowSeconds: 60 * 60,
    perSourceMax: 5,
    perEmailMax: 25,
  },
  "/request-password-reset": {
    purpose: "password_reset",
    windowSeconds: 60 * 60,
    perSourceMax: 5,
    perEmailMax: 25,
  },
  "/send-verification-email": {
    purpose: "verification_email",
    windowSeconds: 60 * 60,
    perSourceMax: 5,
    perEmailMax: 25,
  },
} as const satisfies Record<string, ManagedAuthEmailThrottle>;

export const MANAGED_AUTH_EMAIL_THROTTLE_KEY_PREFIX = "opengeni:email-throttle:v1:";

/** A per-email throttle refusal; an ordinary Better Auth 429 on the wire. */
export class ManagedAuthEmailThrottleError extends APIError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(
      "TOO_MANY_REQUESTS",
      { code: "TOO_MANY_REQUESTS", message: "Too many requests. Please try again later." },
      { "X-Retry-After": String(retryAfterSeconds) },
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function managedAuthEmailThrottleFor(path: string): ManagedAuthEmailThrottle | null {
  return Object.hasOwn(MANAGED_AUTH_EMAIL_THROTTLES, path)
    ? MANAGED_AUTH_EMAIL_THROTTLES[path as keyof typeof MANAGED_AUTH_EMAIL_THROTTLES]
    : null;
}

/**
 * Content-free counter key for one email. The address is normalized the way
 * Better Auth stores it and keyed-hashed so the rate-limit table never holds
 * an email.
 */
export function managedAuthEmailThrottleKey(
  secret: string,
  purpose: ManagedAuthEmailThrottle["purpose"],
  email: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(`opengeni:managed-auth:email-throttle:v1\n${purpose}\n${normalizedEmail(email)}`)
    .digest("hex");
  return `${MANAGED_AUTH_EMAIL_THROTTLE_KEY_PREFIX}${purpose}:${digest}`;
}

/**
 * Content-free counter key for one (email, client address) pair; `source` is
 * a {@link requestSourceRateLimitKey}. Neither value is stored.
 */
export function managedAuthEmailSourceThrottleKey(
  secret: string,
  purpose: ManagedAuthEmailThrottle["purpose"],
  email: string,
  source: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(
      `opengeni:managed-auth:email-source-throttle:v1\n${purpose}\n${normalizedEmail(email)}\n${source}`,
    )
    .digest("hex");
  return `${MANAGED_AUTH_EMAIL_THROTTLE_KEY_PREFIX}${purpose}:source:${digest}`;
}

/**
 * The limiter source for a Better Auth request: the trusted address the API
 * stamped on it, as a rate-limit key. The API strips caller-supplied copies,
 * so a request without one (an in-process call without a transport peer)
 * shares the unknown-source bucket.
 */
export function managedAuthThrottleSource(headers: Headers | null | undefined): string {
  const stamped = headers?.get(TRUSTED_CLIENT_ADDRESS_HEADER)?.trim();
  return stamped && isIP(stamped) !== 0
    ? requestSourceRateLimitKey(stamped.toLowerCase())
    : UNKNOWN_REQUEST_SOURCE_ADDRESS;
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Atomically count one attempt in a fixed window shared by every API replica.
 *
 * Rows live in Better Auth's `auth_rate_limits` table. For these keys
 * `last_request` holds the window deadline (epoch milliseconds) rather than
 * the last request time: Better Auth prunes rows whose `last_request` is more
 * than 60 s in the past, so storing the deadline keeps an active window alive
 * and lets pruning reclaim it 60 s after it expires. Database time is the only
 * clock, so replicas with skewed clocks agree.
 */
export async function consumeManagedAuthEmailThrottle(
  db: Pick<Database, "execute">,
  input: { key: string; windowSeconds: number; max: number },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const windowMs = input.windowSeconds * 1_000;
  const result = await db.execute(sql`
    insert into auth_rate_limits as bucket (id, key, count, last_request)
    values (
      ${input.key},
      ${input.key},
      1,
      floor(extract(epoch from clock_timestamp()) * 1000)::bigint + ${windowMs}::bigint
    )
    on conflict (key) do update set
      count = case
        when bucket.last_request <= excluded.last_request - ${windowMs}::bigint then 1
        else least(bucket.count + 1, ${input.max + 1}::integer)
      end,
      last_request = case
        when bucket.last_request <= excluded.last_request - ${windowMs}::bigint
          then excluded.last_request
        else bucket.last_request
      end
    returning
      bucket.count as count,
      greatest(
        1,
        ceil((bucket.last_request - extract(epoch from clock_timestamp()) * 1000) / 1000.0)
      )::integer as retry_after_seconds
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows) as
    | Array<{ count: number | string; retry_after_seconds: number | string }>
    | undefined;
  const row = rows?.[0];
  if (!row) throw new Error("managed auth email throttle returned no row");
  return {
    allowed: Number(row.count) <= input.max,
    retryAfterSeconds: Number(row.retry_after_seconds),
  };
}

/**
 * Better Auth `hooks.before` middleware. It runs after Better Auth's own
 * per-client-address limiter and for both HTTP requests and server-side
 * `auth.api.*` calls, so the product session-set sign-in is covered too. The
 * per-(email, address) window is consumed first; only an attempt it admits
 * counts toward the email's shared window.
 */
export function createManagedAuthEmailThrottleHook(db: Pick<Database, "execute">, secret: string) {
  return createAuthMiddleware(async (ctx) => {
    const throttle = managedAuthEmailThrottleFor(ctx.path);
    if (!throttle) return;
    const email = (ctx.body as { email?: unknown } | undefined)?.email;
    if (typeof email !== "string" || !email.trim()) return;
    const source = managedAuthThrottleSource(ctx.headers);
    const perSource = await consumeManagedAuthEmailThrottle(db, {
      key: managedAuthEmailSourceThrottleKey(secret, throttle.purpose, email, source),
      windowSeconds: throttle.windowSeconds,
      max: throttle.perSourceMax,
    });
    if (!perSource.allowed) throw new ManagedAuthEmailThrottleError(perSource.retryAfterSeconds);
    const perEmail = await consumeManagedAuthEmailThrottle(db, {
      key: managedAuthEmailThrottleKey(secret, throttle.purpose, email),
      windowSeconds: throttle.windowSeconds,
      max: throttle.perEmailMax,
    });
    if (!perEmail.allowed) throw new ManagedAuthEmailThrottleError(perEmail.retryAfterSeconds);
  });
}
