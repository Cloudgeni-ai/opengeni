import { createHmac } from "node:crypto";

import { APIError } from "better-auth/api";
import { decodeJwt } from "jose";
import type { Pool } from "pg";

/**
 * Email verification proves who controls an address, not who chose the
 * password stored on the account. Anyone can sign up with an address they
 * don't control, so verification must never activate a password the
 * verifying person did not choose:
 *
 * - While an address is unverified, every email sign-up for it replaces the
 *   account's password with its own: the newest sign-up wins and nothing is
 *   silently dropped.
 * - Every verification link carries a keyed digest of the password stored
 *   when it was sent (the `signUp` claim of its signed token). A newer
 *   sign-up replaces the password, so earlier links stop working and are
 *   refused like any invalid link; the person can request a new email.
 * - Following the current link verifies the address with that sign-up's
 *   password, from any browser or device, and revokes existing sessions.
 */

const SIGN_UP_CLAIM = "signUp";

function signUpDigest(secret: string, userId: string, passwordHash: string | null): string | null {
  if (!passwordHash) return null;
  return createHmac("sha256", secret)
    .update(`opengeni:email-verification-sign-up\n${userId}\n${passwordHash}`)
    .digest("base64url");
}

/** Claims that bind a verification link to the password stored when it is sent. */
export function managedSignUpVerificationClaims(
  secret: string,
  userId: string,
  passwordHash: string | null,
): Record<string, string> {
  const digest = signUpDigest(secret, userId, passwordHash);
  return { userId, ...(digest ? { [SIGN_UP_CLAIM]: digest } : {}) };
}

/** The password hash currently stored on a user's email-and-password identity. */
export async function currentManagedSignUpPasswordHash(
  pool: Pool,
  userId: string,
): Promise<string | null> {
  const result = await pool.query<{ password: string | null }>(
    `select password from auth_identities
      where user_id = $1 and provider_id = 'credential'
      order by created_at limit 1`,
    [userId],
  );
  return result.rows[0]?.password ?? null;
}

/**
 * Store a repeated sign-up's password on an unverified account, replacing any
 * earlier one. Runs under the auth user's row lock, like verification, so a
 * link is never verified against a password a concurrent sign-up replaced.
 * Returns the password hash the account now holds, or `"verified"` when the
 * address was verified meanwhile and nothing changed. An account without an
 * email-and-password identity gets none: a sign-up never adds a password to
 * an account its owner created another way.
 */
export async function replaceManagedSignUpPassword(
  pool: Pool,
  input: { userId: string; passwordHash: string },
): Promise<string | null | "verified"> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query<{ email_verified: boolean }>(
      "select email_verified from auth_users where id = $1 for update",
      [input.userId],
    );
    if (!locked.rows[0] || locked.rows[0].email_verified) {
      await client.query("commit");
      return "verified";
    }
    const updated = await client.query(
      `update auth_identities set password = $2, updated_at = now()
        where user_id = $1 and provider_id = 'credential'`,
      [input.userId, input.passwordHash],
    );
    await client.query("commit");
    return updated.rowCount ? input.passwordHash : null;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Verify an address through a link, under the auth user's row lock: refuse a
 * link whose sign-up a newer one has replaced; otherwise revoke the user's
 * sessions and mark the address verified, keeping the stored password. A
 * repeated click finds the address already verified and changes nothing.
 */
export async function verifyManagedSignUpEmail(
  pool: Pool,
  input: { secret: string; userId: string; signUp: string | null },
): Promise<"verified" | "already_verified" | "superseded"> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query<{ email_verified: boolean }>(
      "select email_verified from auth_users where id = $1 for update",
      [input.userId],
    );
    if (!locked.rows[0] || locked.rows[0].email_verified) {
      await client.query("commit");
      return "already_verified";
    }
    const identity = await client.query<{ password: string | null }>(
      `select password from auth_identities
        where user_id = $1 and provider_id = 'credential'
        order by created_at limit 1`,
      [input.userId],
    );
    const expected = signUpDigest(input.secret, input.userId, identity.rows[0]?.password ?? null);
    if (expected !== input.signUp) {
      await client.query("rollback");
      return "superseded";
    }
    await client.query("delete from auth_sessions where user_id = $1", [input.userId]);
    await client.query(
      "update auth_users set email_verified = true, updated_at = now() where id = $1",
      [input.userId],
    );
    await client.query("commit");
    return "verified";
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The sign-up a verification request's link is bound to. Better Auth has
 * already checked the token's signature and expiry before this runs.
 */
export function managedSignUpOfVerificationRequest(request: Request | undefined): string | null {
  const token = request ? new URL(request.url).searchParams.get("token") : null;
  if (!token) return null;
  try {
    const claim = decodeJwt(token)[SIGN_UP_CLAIM];
    return typeof claim === "string" ? claim : null;
  } catch {
    return null;
  }
}

/**
 * The response Better Auth gives any invalid verification link: a redirect to
 * the callback URL (already origin-checked by Better Auth) with
 * `error=INVALID_TOKEN`, or a 401 without one.
 */
export function invalidManagedVerificationLink(request: Request | undefined): APIError {
  const callbackURL = request ? new URL(request.url).searchParams.get("callbackURL") : null;
  if (callbackURL) {
    const hashAt = callbackURL.indexOf("#");
    const path = hashAt < 0 ? callbackURL : callbackURL.slice(0, hashAt);
    const fragment = hashAt < 0 ? "" : callbackURL.slice(hashAt);
    const separator = !path.includes("?") ? "?" : /[?&]$/u.test(path) ? "" : "&";
    return new APIError("FOUND", undefined, {
      location: `${path}${separator}error=INVALID_TOKEN${fragment}`,
    });
  }
  return APIError.from("UNAUTHORIZED", { code: "INVALID_TOKEN", message: "Invalid token" });
}

/**
 * The password and callback URL of an email sign-up request, read from its
 * (cloned) body. Better Auth has already origin-checked the callback URL.
 */
export async function managedSignUpRequestFields(
  request: Request | undefined,
): Promise<{ password: string | null; callbackURL: string | null }> {
  const none = { password: null, callbackURL: null };
  if (!request || request.method !== "POST" || !request.body) return none;
  try {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    const body: unknown = contentType.includes("application/x-www-form-urlencoded")
      ? Object.fromEntries(await request.formData())
      : await request.json();
    const fields = body as { password?: unknown; callbackURL?: unknown } | null;
    return {
      password: typeof fields?.password === "string" ? fields.password : null,
      callbackURL:
        typeof fields?.callbackURL === "string" && fields.callbackURL ? fields.callbackURL : null,
    };
  } catch {
    return none;
  }
}
