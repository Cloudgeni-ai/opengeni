import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";

/**
 * The deployment's at-rest encryption key (`OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`),
 * shared by vault values and stored connection credentials.
 */
export function requireEnvironmentEncryption(settings: Settings): Uint8Array {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new HTTPException(503, {
      message: "secrets require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
    });
  }
  return key;
}

/**
 * RM-1 for internal callers: Variable Sets were replaced by vaults, so a
 * request that still selects one is refused instead of silently ignored.
 */
export function variableSetsRemovedError(field: string): HTTPException {
  return new HTTPException(422, {
    message: `variable_sets_removed: ${field} is no longer supported; Variable Sets were replaced by vaults (use vaultPolicy)`,
  });
}
