import { createHmac } from "node:crypto";
import type { Database } from "@opengeni/db";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { sql } from "drizzle-orm";

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
 */
export const MANAGED_AUTH_CLIENT_RATE_LIMIT_RULES = {
  "/sign-in/email": { window: 60, max: 10 },
  "/sign-up/email": { window: 60, max: 10 },
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
  max: number;
};

/**
 * Per-email throttles for the endpoints that verify a password or send mail
 * to an address. They bound password guessing against one account and mail
 * bombing of one inbox regardless of how many client addresses an attacker
 * rotates through. Every attempt counts, including successful sign-ins.
 */
export const MANAGED_AUTH_EMAIL_THROTTLES = {
  "/sign-in/email": { purpose: "sign_in", windowSeconds: 15 * 60, max: 10 },
  "/sign-up/email": { purpose: "sign_up", windowSeconds: 60 * 60, max: 5 },
  "/request-password-reset": { purpose: "password_reset", windowSeconds: 60 * 60, max: 5 },
  "/send-verification-email": { purpose: "verification_email", windowSeconds: 60 * 60, max: 5 },
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
 * Content-free counter key. The address is normalized the way Better Auth
 * stores it and keyed-hashed so the rate-limit table never holds an email.
 */
export function managedAuthEmailThrottleKey(
  secret: string,
  purpose: ManagedAuthEmailThrottle["purpose"],
  email: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(`opengeni:managed-auth:email-throttle:v1\n${purpose}\n${email.trim().toLowerCase()}`)
    .digest("hex");
  return `${MANAGED_AUTH_EMAIL_THROTTLE_KEY_PREFIX}${purpose}:${digest}`;
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
 * `auth.api.*` calls, so the product session-set sign-in is covered too.
 */
export function createManagedAuthEmailThrottleHook(db: Pick<Database, "execute">, secret: string) {
  return createAuthMiddleware(async (ctx) => {
    const throttle = managedAuthEmailThrottleFor(ctx.path);
    if (!throttle) return;
    const email = (ctx.body as { email?: unknown } | undefined)?.email;
    if (typeof email !== "string" || !email.trim()) return;
    const decision = await consumeManagedAuthEmailThrottle(db, {
      key: managedAuthEmailThrottleKey(secret, throttle.purpose, email),
      windowSeconds: throttle.windowSeconds,
      max: throttle.max,
    });
    if (!decision.allowed) throw new ManagedAuthEmailThrottleError(decision.retryAfterSeconds);
  });
}
