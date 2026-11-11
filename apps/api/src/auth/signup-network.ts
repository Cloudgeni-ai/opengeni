import { createHmac } from "node:crypto";
import type { Settings } from "@opengeni/config";
import type { SignupNetworkSource } from "@opengeni/db";
import type { Context } from "hono";

import { requestSourceNetwork, trustedRequestSourceAddress } from "../http/request-source";

/** User-facing refusal for the per-network rate limit on new self-serve organizations. */
export const SIGNUP_NETWORK_RATE_LIMIT_MESSAGE =
  "Too many new organizations were created from your network in the last hour. Please try again later, or ask a teammate to invite you to their organization.";
export const SIGNUP_NETWORK_RATE_LIMIT_CODE = "organization_setup_rate_limited";

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
