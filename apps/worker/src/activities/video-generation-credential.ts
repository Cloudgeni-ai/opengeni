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
    }>;

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
