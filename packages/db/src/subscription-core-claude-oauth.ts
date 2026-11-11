/**
 * Claude's OAuth token refresh, owned by the shared-core Claude adapter
 * (design 5.3, Claude track; moved here from the deleted legacy token module
 * by C4): the refresh request with its ten-second deadline and bounded
 * bodies, the credential a refresh produces, and the two refusals the
 * adapter, the bearer resolver and the worker classify. Pure helpers: no
 * database access and no legacy table.
 */
import {
  CLAUDE_OAUTH_PROFILE_URL,
  claudeSubscriptionProfilePlan,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_SCOPES,
  CLAUDE_OAUTH_TOKEN_URL,
  ClaudeOAuthTokenResponse,
  ClaudeSubscriptionCredential,
} from "@opengeni/config";
import { readResponseJsonBounded } from "@opengeni/network";
import type { z } from "zod";

/** The sign-in was refused or revoked: only a new sign-in recovers it. */
export class ClaudeSubscriptionReconnectRequired extends Error {
  readonly status = 401;
  constructor() {
    super("Claude sign-in expired or was revoked. Sign in again in Models.");
  }
}

/** The refresh failed for a reason a later attempt may not repeat. */
export class ClaudeSubscriptionRefreshUnavailable extends Error {
  readonly status = 503;
  constructor() {
    super("Couldn't renew Claude sign-in. Try again.");
  }
}

type ClaudeCredential = z.infer<typeof ClaudeSubscriptionCredential>;

/**
 * One OAuth refresh. A 401 or `invalid_grant`, or a response missing a
 * required scope, is a relogin; anything else is a retryable failure. A
 * credential without `oauth` (a setup token) never refreshes.
 */
export async function requestClaudeTokenRefresh(
  bundle: ClaudeCredential,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  const oauth = bundle.oauth;
  if (!oauth) throw new ClaudeSubscriptionReconnectRequired();
  try {
    const signal = AbortSignal.timeout(10_000);
    const response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        refresh_token: oauth.refreshToken,
        scope: oauth.scopes.join(" "),
      }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 400) {
        const body = await readResponseJsonBounded<unknown>(response, 16 * 1024, "Claude refresh", {
          signal,
        }).catch(() => null);
        const error = body && typeof body === "object" && "error" in body ? body.error : null;
        if (response.status === 401 || error === "invalid_grant")
          throw new ClaudeSubscriptionReconnectRequired();
      } else await response.body?.cancel().catch(() => undefined);
      throw new ClaudeSubscriptionRefreshUnavailable();
    }
    const tokens = ClaudeOAuthTokenResponse.parse(
      await readResponseJsonBounded(response, 64 * 1024, "Claude refresh", {
        signal,
      }),
    );
    if (!CLAUDE_OAUTH_SCOPES.every((required) => tokens.scope.split(/\s+/).includes(required)))
      throw new ClaudeSubscriptionReconnectRequired();
    return tokens;
  } catch (error) {
    if (error instanceof ClaudeSubscriptionReconnectRequired) throw error;
    throw new ClaudeSubscriptionRefreshUnavailable();
  }
}

/**
 * The credential an OAuth refresh produced: the new access token, the rotated
 * refresh token (or the current one when Claude kept it), the new expiry and
 * the granted scopes. The identity is kept. Every Claude refresh path builds
 * it here.
 */
export function claudeRefreshedCredential(
  credential: ClaudeCredential,
  tokens: Awaited<ReturnType<typeof requestClaudeTokenRefresh>>,
  nowMs: number,
) {
  if (!credential.oauth) throw new ClaudeSubscriptionReconnectRequired();
  const expiresAt = new Date(nowMs + tokens.expires_in * 1000);
  return {
    credential: ClaudeSubscriptionCredential.parse({
      ...credential,
      token: tokens.access_token,
      oauth: {
        ...credential.oauth,
        refreshToken: tokens.refresh_token ?? credential.oauth.refreshToken,
        expiresAt: expiresAt.toISOString(),
        scopes: tokens.scope.split(/\s+/).filter(Boolean),
      },
    }),
    expiresAt,
  };
}

/**
 * The plan a Claude sign-in reports at renewal, from the profile endpoint:
 * Claude's token refresh reports none, so a plan change (or the Max tier,
 * Max or Ultra) shows after the next renewal instead of only on a new
 * sign-in. Optional: without the `user:profile` scope, or on any failure, it
 * is null and the recorded plan stays. A Max plan whose tier the profile
 * doesn't name is null too, so an unresolved read never replaces a known
 * tier (a plan change also clears the connection's model cooldowns). Never
 * throws; its deadline bounds how long the renewal waits for it.
 */
export async function requestClaudeProfilePlan(
  token: string,
  scopes: readonly string[],
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  if (!scopes.includes("user:profile")) return null;
  try {
    const signal = AbortSignal.timeout(3_000);
    const response = await fetchImpl(CLAUDE_OAUTH_PROFILE_URL, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const plan = claudeSubscriptionProfilePlan(
      await readResponseJsonBounded<unknown>(response, 64 * 1024, "Claude profile", { signal }),
    );
    return plan === "claude_max" ? null : plan;
  } catch {
    return null;
  }
}
