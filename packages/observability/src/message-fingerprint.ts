import { createHash } from "node:crypto";

/**
 * One-way fingerprint (`m_<10 hex>`) of an error or refusal message, so logs
 * can group identical failures and `scripts/resolve-rejection-fingerprint.ts`
 * can map one back to its source literal without the message reaching logs.
 */
export function messageFingerprint(message: string): string {
  return `m_${createHash("sha256").update(normalizeFingerprintMessage(message)).digest("hex").slice(0, 10)}`;
}

/** Identifiers, quoted values, and numbers never distinguish two fingerprints. */
export function normalizeFingerprintMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<q>")
    .replace(/[0-9]+/g, "0")
    .replace(/\s+/g, " ")
    .trim();
}

export const MESSAGE_FINGERPRINT_PATTERN = /^m_[0-9a-f]{10}$/;
