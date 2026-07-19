import { createHash, createHmac } from "node:crypto";

const SESSION_CREATE_FINGERPRINT_DOMAIN = "opengeni:session-create:v1";
const SESSION_CREATE_CREDENTIAL_DOMAIN = "opengeni:session-create-credentials:v1";

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deterministic JSON for a validated request. Object keys use codepoint order
 * (never locale-dependent ordering); array order is preserved because resource,
 * tool, MCP-server, and approval-list order can affect persisted/runtime truth.
 * Undefined values are omitted from objects exactly as JSON.stringify does.
 */
export function canonicalSessionCreateJson(value: unknown): string {
  const normalize = (candidate: unknown, inArray: boolean): CanonicalJson | undefined => {
    if (candidate === null) return null;
    if (typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error("session create fingerprint contains a non-finite number");
      }
      return candidate;
    }
    if (candidate === undefined) return inArray ? null : undefined;
    if (Array.isArray(candidate)) {
      return candidate.map((item) => normalize(item, true) ?? null);
    }
    if (typeof candidate === "object") {
      if (Object.getPrototypeOf(candidate) !== Object.prototype) {
        throw new Error("session create fingerprint accepts only plain JSON objects");
      }
      const result: Record<string, CanonicalJson> = {};
      for (const key of Object.keys(candidate as Record<string, unknown>).sort(codepointCompare)) {
        const normalized = normalize((candidate as Record<string, unknown>)[key], false);
        if (normalized !== undefined) result[key] = normalized;
      }
      return result;
    }
    throw new Error(`session create fingerprint contains unsupported ${typeof candidate}`);
  };

  const normalized = normalize(value, false);
  if (normalized === undefined) {
    throw new Error("session create fingerprint root cannot be undefined");
  }
  return JSON.stringify(normalized);
}

/**
 * Produce a safe digest for normalized MCP credential headers. The keyed HMAC
 * prevents an attacker who can read a request receipt from dictionary-testing
 * low-entropy secrets. Only this digest is included in the outer fingerprint.
 */
export function fingerprintSessionMcpCredentialHeaders(
  encryptionKey: Uint8Array,
  headers: Record<string, string>,
): string {
  return createHmac("sha256", encryptionKey)
    .update(SESSION_CREATE_CREDENTIAL_DOMAIN)
    .update("\0")
    .update(canonicalSessionCreateJson(headers))
    .digest("hex");
}

/** Hash already-secret-safe normalized request identity into the DB receipt. */
export function fingerprintSessionCreateRequest(normalizedRequest: unknown): string {
  const digest = createHash("sha256")
    .update(SESSION_CREATE_FINGERPRINT_DOMAIN)
    .update("\0")
    .update(canonicalSessionCreateJson(normalizedRequest))
    .digest("hex");
  return `v1:${digest}`;
}
