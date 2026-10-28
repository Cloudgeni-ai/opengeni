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
