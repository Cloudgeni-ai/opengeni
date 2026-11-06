import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

import type { Settings } from "@opengeni/config";
import type { MiddlewareHandler } from "hono";
import type { Pool } from "pg";

import { trustedBrowserOrigins } from "../http/browser-mutation-origin";

/**
 * Email verification proves who controls an address, not who chose the
 * password stored on the account. Anyone can sign up with an address they
 * don't control, and the owner may later follow a verification link (their
 * own or an unsolicited one). So a password only becomes usable on
 * verification when the verifying request comes from the browser that chose
 * it during sign-up:
 *
 * - Every email sign-up response sets an HttpOnly cookie holding a random
 *   browser nonce (reused while the browser still has one). While the address
 *   is unverified, a sign-up sent from one of the deployment's trusted
 *   browser origins remembers its password hash under that browser's nonce.
 *   A sign-up with a missing or foreign `Origin` (for example a cross-site
 *   form post another page makes the person's browser send) remembers
 *   nothing, so its password can never become usable on verification.
 * - Verification looks up the password remembered for the verifying browser.
 *   If there is one, it becomes the account's password; otherwise every stored
 *   password is discarded and the person sets one with a password reset.
 *   Either way the address is verified, sessions are revoked and the answer
 *   is the same.
 */

const COOKIE_NAME = "opengeni.sign_up_browser";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const RECORD_PREFIX = "opengeni:sign-up-password:";

const signUpBrowserStorage = new AsyncLocalStorage<string | null>();

/** The browser nonce of the email sign-up or verification request being handled. */
export function currentManagedSignUpBrowser(): string | null {
  return signUpBrowserStorage.getStore() ?? null;
}

function managedSignUpBrowserCookieName(settings: Pick<Settings, "publicBaseUrl">): string {
  return settings.publicBaseUrl?.startsWith("https://") ? `__Secure-${COOKIE_NAME}` : COOKIE_NAME;
}

function readNonce(cookieHeader: string | undefined, name: string): string | null {
  for (const part of cookieHeader?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (NONCE_PATTERN.test(value)) return value;
  }
  return null;
}

/**
 * Runs email sign-up and email verification inside the browser's nonce, and
 * gives every sign-up response the nonce cookie, whatever its outcome, so
 * the response reveals nothing about existing accounts. Sign-up binds the
 * nonce only for a trusted browser `Origin`. Managed auth exists only in
 * managed access mode, where those origins are the configured ones.
 */
export function managedSignUpBrowserMiddleware(
  settings: Pick<
    Settings,
    "publicBaseUrl" | "webBaseUrl" | "betterAuthTrustedOrigins" | "betterAuthCookieDomain"
  >,
): MiddlewareHandler {
  const name = managedSignUpBrowserCookieName(settings);
  const secure = name.startsWith("__Secure-");
  const trustedOrigins = trustedBrowserOrigins(settings);
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const existing = readNonce(c.req.header("cookie"), name);
    if (path === "/v1/auth/verify-email" && c.req.method === "GET") {
      await signUpBrowserStorage.run(existing, next);
      return;
    }
    if (path !== "/v1/auth/sign-up/email" || c.req.method !== "POST") {
      await next();
      return;
    }
    const nonce = existing ?? randomBytes(32).toString("base64url");
    const origin = c.req.header("origin");
    const trusted = origin !== undefined && trustedOrigins.includes(origin);
    await signUpBrowserStorage.run(trusted ? nonce : null, next);
    const attributes = [
      `${name}=${nonce}`,
      "Path=/v1/auth",
      `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
      "HttpOnly",
      "SameSite=Lax",
      ...(secure ? ["Secure"] : []),
      ...(settings.betterAuthCookieDomain ? [`Domain=${settings.betterAuthCookieDomain}`] : []),
    ];
    c.header("set-cookie", attributes.join("; "), { append: true });
  };
}

function recordIdentifier(userId: string, nonce: string): string {
  const digest = createHash("sha256").update(nonce).digest("base64url");
  return `${RECORD_PREFIX}${userId}:${digest}`;
}

/** Remember the password hash an email sign-up chose for an unverified account in this browser. */
export async function rememberManagedSignUpPassword(
  pool: Pool,
  input: { userId: string; nonce: string; passwordHash: string },
): Promise<void> {
  const identifier = recordIdentifier(input.userId, input.nonce);
  await pool.query(
    `with replaced as (delete from auth_verifications where identifier = $2)
     insert into auth_verifications (id, identifier, value, expires_at, created_at, updated_at)
     values ($1, $2, $3, now() + make_interval(secs => $4), now(), now())`,
    [crypto.randomUUID(), identifier, input.passwordHash, COOKIE_MAX_AGE_SECONDS],
  );
}

/**
 * Settle the account's password as its address becomes verified: keep only
 * the password the verifying browser chose at sign-up, discard every other,
 * revoke sessions, and mark the address verified. Runs under the auth user's
 * row lock, so a repeated click finds the address already verified and
 * changes nothing.
 */
export async function settleManagedSignUpPasswordOnVerification(
  pool: Pool,
  input: { userId: string; nonce: string | null },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query<{ email_verified: boolean }>(
      "select email_verified from auth_users where id = $1 for update",
      [input.userId],
    );
    if (!locked.rows[0] || locked.rows[0].email_verified) {
      await client.query("commit");
      return;
    }
    const chosen = input.nonce
      ? (
          await client.query<{ value: string }>(
            `select value from auth_verifications
              where identifier = $1 and expires_at > now()
              order by updated_at desc limit 1`,
            [recordIdentifier(input.userId, input.nonce)],
          )
        ).rows[0]?.value
      : undefined;
    await client.query(
      `update auth_identities set password = $2, updated_at = now()
        where user_id = $1 and provider_id = 'credential'`,
      [input.userId, chosen ?? null],
    );
    await client.query("delete from auth_verifications where starts_with(identifier, $1)", [
      `${RECORD_PREFIX}${input.userId}:`,
    ]);
    await client.query("delete from auth_sessions where user_id = $1", [input.userId]);
    await client.query(
      "update auth_users set email_verified = true, updated_at = now() where id = $1",
      [input.userId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The password of an email sign-up request, read from its (cloned) body. */
export async function managedSignUpRequestPassword(
  request: Request | undefined,
): Promise<string | null> {
  if (!request || request.method !== "POST" || !request.body) return null;
  try {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    const body: unknown = contentType.includes("application/x-www-form-urlencoded")
      ? Object.fromEntries(await request.formData())
      : await request.json();
    const password = (body as { password?: unknown } | null)?.password;
    return typeof password === "string" ? password : null;
  } catch {
    return null;
  }
}
