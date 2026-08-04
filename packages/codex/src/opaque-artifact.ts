import { createHash } from "node:crypto";

/** Stable, content-hiding identity for one opaque provider artifact. */
export function opaqueProviderArtifactFingerprint(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (record.type !== "reasoning" && record.type !== "compaction") return null;
  const providerData =
    record.providerData && typeof record.providerData === "object"
      ? (record.providerData as Record<string, unknown>)
      : null;
  const ciphertext =
    (typeof record.encrypted_content === "string" && record.encrypted_content) ||
    (typeof record.encryptedContent === "string" && record.encryptedContent) ||
    (typeof providerData?.encrypted_content === "string" && providerData.encrypted_content) ||
    (typeof providerData?.encryptedContent === "string" && providerData.encryptedContent) ||
    null;
  if (!ciphertext) return null;
  return `${record.type}:${createHash("sha256").update(ciphertext).digest("hex")}`;
}

/** Exact opaque artifacts present in one normalized provider input array. */
export function opaqueProviderArtifactFingerprints(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => {
    const fingerprint = opaqueProviderArtifactFingerprint(item);
    return fingerprint ? [fingerprint] : [];
  });
}
