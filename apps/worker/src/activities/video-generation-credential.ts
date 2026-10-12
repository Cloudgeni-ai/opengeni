import { decryptEnvironmentValue, encryptEnvironmentValue } from "@opengeni/db";
import type { XaiProviderAccountAuthoritySnapshotV1 } from "@opengeni/contracts";

export type VideoGenerationProviderCredential =
  | Readonly<{ kind: "api-key"; apiKey: string }>
  | Readonly<{
      kind: "xai-subscription";
      accessToken: string;
      refreshToken: string;
      userId: string;
      credentialId: string;
      subjectId: string;
      authoritySnapshot: XaiProviderAccountAuthoritySnapshotV1;
    }>
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

export function encryptVideoGenerationXaiCredential(
  key: Uint8Array,
  credential: Omit<
    Extract<VideoGenerationProviderCredential, { kind: "xai-subscription" }>,
    "kind"
  >,
): string {
  if (
    !credential.accessToken.trim() ||
    !credential.refreshToken.trim() ||
    !credential.userId.trim() ||
    !credential.credentialId.trim() ||
    !credential.subjectId.trim()
  ) {
    throw new Error("SuperGrok video credential is incomplete");
  }
  return encryptEnvironmentValue(key, JSON.stringify({ kind: "xai-subscription", ...credential }));
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
  const authority =
    row?.authoritySnapshot &&
    typeof row.authoritySnapshot === "object" &&
    !Array.isArray(row.authoritySnapshot)
      ? (row.authoritySnapshot as Record<string, unknown>)
      : null;
  if (
    row?.kind !== "xai-subscription" ||
    typeof row.accessToken !== "string" ||
    !row.accessToken.trim() ||
    typeof row.refreshToken !== "string" ||
    !row.refreshToken.trim() ||
    typeof row.userId !== "string" ||
    !row.userId.trim() ||
    typeof row.credentialId !== "string" ||
    !row.credentialId.trim() ||
    typeof row.subjectId !== "string" ||
    !row.subjectId.trim() ||
    authority?.version !== 1 ||
    (authority.scope !== "workspace" && authority.scope !== "user") ||
    (authority.scope === "user" && !Number.isSafeInteger(authority.authorityGeneration))
  ) {
    throw new Error("Video provider credential lease is malformed");
  }
  return Object.freeze({
    kind: "xai-subscription",
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    userId: row.userId,
    credentialId: row.credentialId,
    subjectId: row.subjectId,
    authoritySnapshot: authority as XaiProviderAccountAuthoritySnapshotV1,
  });
}

export function decryptVideoGenerationApiKey(key: Uint8Array, stored: string): string {
  const credential = decryptVideoGenerationCredential(key, stored);
  if (credential.kind !== "api-key") {
    throw new Error("Video provider credential is not an API key");
  }
  return credential.apiKey;
}
