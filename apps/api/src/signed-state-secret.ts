import { createHmac, randomUUID } from "node:crypto";
import type { Settings } from "@opengeni/config";

/** Domain label: a derived key never equals, or reveals, the secret it came from. */
const SIGNED_STATE_DERIVATION_LABEL = "opengeni/signed-browser-state/v1";

export type SignedStateSecretSource =
  | "explicit"
  | "integrations_state_secret"
  | "better_auth_secret"
  | "environments_encryption_key"
  | "process_random";

/**
 * Resolves the key that signs short-lived browser state (GitHub App setup,
 * Codex device sign-in, PR review install and similar round trips).
 *
 * Every API replica must resolve the same key, or a state minted by one
 * replica is refused by the next. An explicit
 * `OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET` is used as-is. Otherwise the key
 * is derived (HMAC with a fixed label) from the first stable deployment secret
 * that exists, so multi-replica deployments work without an extra variable.
 * Only a deployment with no stable secret at all falls back to a per-process
 * random key, which is correct for a single process only.
 */
export function resolveSignedStateSecret(
  settings: Pick<
    Settings,
    | "githubAppManifestStateSecret"
    | "integrationsStateSecret"
    | "betterAuthSecret"
    | "environmentsEncryptionKey"
  >,
): { secret: string; source: SignedStateSecretSource } {
  const explicit = nonEmpty(settings.githubAppManifestStateSecret);
  if (explicit) return { secret: explicit, source: "explicit" };
  const candidates: Array<[SignedStateSecretSource, string | undefined]> = [
    ["integrations_state_secret", settings.integrationsStateSecret],
    ["better_auth_secret", settings.betterAuthSecret],
    ["environments_encryption_key", settings.environmentsEncryptionKey],
  ];
  for (const [source, value] of candidates) {
    const base = nonEmpty(value);
    if (base) {
      return {
        secret: createHmac("sha256", base)
          .update(SIGNED_STATE_DERIVATION_LABEL)
          .digest("base64url"),
        source,
      };
    }
  }
  return { secret: randomUUID(), source: "process_random" };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}
