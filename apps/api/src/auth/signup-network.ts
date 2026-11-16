import { createHmac } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  evaluateSignupNetworkAccounts,
  nestedPostgresSqlState,
  type Database,
  type SignupNetworkSource,
} from "@opengeni/db";
import type { Context } from "hono";

import { ApiHttpError } from "../http/api-error";
import { requestSourceNetwork, trustedRequestSourceAddress } from "../http/request-source";

/** User-facing refusal for the per-network rate limit on new self-serve organizations. */
export const SIGNUP_NETWORK_RATE_LIMIT_MESSAGE =
  "Too many new organizations were created from your network in the last hour. Please try again later, or ask a teammate to invite you to their organization.";
export const SIGNUP_NETWORK_RATE_LIMIT_CODE = "organization_setup_rate_limited";

/** The HTTP 429 for a setup the network rate limit refused (SQLSTATE OG429). */
export function signupNetworkRateLimitError(): ApiHttpError {
  return new ApiHttpError(429, {
    code: "limit_exceeded",
    message: SIGNUP_NETWORK_RATE_LIMIT_MESSAGE,
    retryable: true,
    details: { managedAuthCode: SIGNUP_NETWORK_RATE_LIMIT_CODE },
  });
}

/**
 * After a new self-serve organization committed, evaluates it and the recent
 * same-network organizations the setup trigger listed, each in its own
 * account transaction, so reserve accounts of a burst are held before they
 * spend. Best-effort and never throws: Free issuance and admission evaluate
 * each account lazily anyway.
 */
export async function evaluateSignupNetworkAccountsAfterSetup(
  db: Database,
  accountIds: readonly string[],
): Promise<void> {
  if (accountIds.length === 0) return;
  await evaluateSignupNetworkAccounts(db, accountIds, (_accountId, error) => {
    console.warn("[api] could not evaluate a signup network account", {
      sqlState: nestedPostgresSqlState(error) ?? null,
    });
  }).catch(() => undefined);
}

const KEY_LABEL = "opengeni:signup-network:v1";

/**
 * Keyed hashes of the client (IPv4 address or IPv6 /64) and its /24 or /48 prefix, for
 * signup network velocity. The HMAC key is derived from the existing
 * Better Auth secret, so no new secret is required; rotating that secret
 * starts new groups. Returns null, and nothing is recorded, when the address
 * is unknown or there is no secret: unknown sources must never group.
 */
export function signupNetworkSource(
  address: string,
  secret: string | undefined,
): SignupNetworkSource | null {
  const network = requestSourceNetwork(address);
  if (!network || !secret) return null;
  const key = createHmac("sha256", secret).update(KEY_LABEL).digest();
  const digest = (value: string) => createHmac("sha256", key).update(value).digest("hex");
  return {
    addressHash: digest(`address:${network.exact}`),
    prefixHash: digest(`prefix:${network.prefix}`),
  };
}

/** {@link signupNetworkSource} for a request; never throws. */
export function requestSignupNetworkSource(
  c: Context,
  settings: Pick<Settings, "apiTrustedProxyHops" | "apiTrustedProxyCidrs" | "betterAuthSecret">,
): SignupNetworkSource | null {
  try {
    return signupNetworkSource(trustedRequestSourceAddress(c, settings), settings.betterAuthSecret);
  } catch (error) {
    console.warn("[api] could not derive the signup network", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}
