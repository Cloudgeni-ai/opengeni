import { decryptEnvironmentValue, encryptEnvironmentValue } from "@opengeni/db";

export type VideoGenerationProviderCredential =
  | Readonly<{ kind: "api-key"; apiKey: string }>
  /**
   * A subscription-core funded operation (after the provider's cutover
   * receipt): a reference to the canonical connection, no token material.
   * The credential is read through the core connection seam under the
   * operation's `video` lease at each use (design 5.3, EP-N13/EP-N14).
   */
  | Readonly<{ kind: "subscription-connection"; provider: string; connectionId: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One frozen, provider-neutral credential envelope for every video funding route. */
export function encryptVideoGenerationApiKey(key: Uint8Array, apiKey: string): string {
  if (!apiKey.trim()) throw new Error("Video provider credential is empty");
  return encryptEnvironmentValue(key, JSON.stringify({ kind: "api-key", apiKey }));
}

export function encryptVideoGenerationConnectionReference(
  key: Uint8Array,
  reference: { provider: string; connectionId: string },
): string {
  if (!reference.provider.trim() || !UUID.test(reference.connectionId)) {
    throw new Error("Video subscription connection reference is incomplete");
  }
  return encryptEnvironmentValue(
    key,
    JSON.stringify({
      kind: "subscription-connection",
      provider: reference.provider,
      connectionId: reference.connectionId,
    }),
  );
}

/**
 * Decrypt without ever attaching parser/decryption errors: JSON parser errors
 * may quote plaintext and must not enter Temporal failure payloads or logs.
 */
export function decryptVideoGenerationCredential(
  key: Uint8Array,
  stored: string,
): VideoGenerationProviderCredential {
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
  const row =
    decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null;
  if (row?.kind === "api-key" || (row?.kind === undefined && typeof row?.apiKey === "string")) {
    if (typeof row.apiKey !== "string" || !row.apiKey.trim()) {
      throw new Error("Video provider credential lease is malformed");
    }
    return Object.freeze({ kind: "api-key", apiKey: row.apiKey });
  }
  if (row?.kind === "subscription-connection") {
    if (
      typeof row.provider !== "string" ||
      !row.provider.trim() ||
      typeof row.connectionId !== "string" ||
      !UUID.test(row.connectionId)
    ) {
      throw new Error("Video provider credential lease is malformed");
    }
    return Object.freeze({
      kind: "subscription-connection",
      provider: row.provider,
      connectionId: row.connectionId,
    });
  }
  // Anything else, including a legacy token envelope that the SuperGrok
  // cutover did not re-encode, is refused: no token material is decoded.
  throw new Error("Video provider credential lease is malformed");
}

export function decryptVideoGenerationApiKey(key: Uint8Array, stored: string): string {
  const credential = decryptVideoGenerationCredential(key, stored);
  if (credential.kind !== "api-key") {
    throw new Error("Video provider credential is not an API key");
  }
  return credential.apiKey;
}
