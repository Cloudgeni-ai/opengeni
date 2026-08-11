import { decryptEnvironmentValue, encryptEnvironmentValue } from "@opengeni/db";

/** One frozen, provider-neutral credential envelope for every video funding route. */
export function encryptVideoGenerationApiKey(key: Uint8Array, apiKey: string): string {
  if (!apiKey.trim()) throw new Error("Video provider credential is empty");
  return encryptEnvironmentValue(key, JSON.stringify({ apiKey }));
}

/**
 * Decrypt without ever attaching parser/decryption errors: JSON parser errors
 * may quote plaintext and must not enter Temporal failure payloads or logs.
 */
export function decryptVideoGenerationApiKey(key: Uint8Array, stored: string): string {
  let plaintext: string;
  try {
    plaintext = decryptEnvironmentValue(key, stored);
  } catch {
    throw new Error("Video provider credential lease could not be decrypted");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(plaintext);
  } catch {
    throw new Error("Video provider credential lease is malformed");
  }
  const apiKey =
    decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>).apiKey
      : null;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("Video provider credential lease is malformed");
  }
  return apiKey;
}
