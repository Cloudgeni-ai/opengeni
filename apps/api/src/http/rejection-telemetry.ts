import { createHash } from "node:crypto";
import { ErrorCode, Permission } from "@opengeni/contracts";

/**
 * Bounded, content-free classification of a rejected (4xx/5xx) API response,
 * so a refused request can be diagnosed from logs and counted per route without
 * copying the response message, identifiers, or user content into telemetry.
 *
 * - `code` is the public `ErrorEnvelope.code` (a closed enum).
 * - `reason` is `permission:<name>` when the refusal names a missing permission
 *   from the closed permission catalog, else the envelope's typed
 *   `details.code` when it is a short identifier, else `control:<code>` for a
 *   Connected Machine control failure, else `unclassified`.
 * - `fingerprint` is a one-way hash of the message with identifiers and
 *   numbers normalized away. It groups identical refusals in logs; resolve it
 *   back to source text with `bun run scripts/resolve-rejection-fingerprint.ts`.
 *   It never becomes a metric label.
 */
export type HttpRejectionFacts = {
  code: string;
  reason: string;
  fingerprint?: string;
};

const ERROR_CODES: ReadonlySet<string> = new Set(ErrorCode.options);
const PERMISSIONS: ReadonlySet<string> = new Set(Permission.options);
const DETAIL_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MISSING_PERMISSION = /^missing (?:literal )?permission: ([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)/;
const CONTROL_CODE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_ENVELOPE_BYTES = 32 * 1024;

export const UNCLASSIFIED_REJECTION_REASON = "unclassified";

export function rejectionFingerprint(message: string): string {
  return `m_${createHash("sha256").update(normalizeRejectionMessage(message)).digest("hex").slice(0, 10)}`;
}

/** Identifiers, quoted values, and numbers never distinguish two fingerprints. */
export function normalizeRejectionMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<q>")
    .replace(/[0-9]+/g, "0")
    .replace(/\s+/g, " ")
    .trim();
}

export function rejectionReasonFromMessage(message: string | undefined): string | null {
  if (!message) return null;
  const permission = MISSING_PERMISSION.exec(message)?.[1];
  return permission && PERMISSIONS.has(permission) ? `permission:${permission}` : null;
}

/** Classify a parsed `ErrorEnvelope`-shaped body. Unknown shapes still get a code. */
export function httpRejectionFactsFromEnvelope(
  envelope: unknown,
  fallbackCode: string,
): HttpRejectionFacts {
  const error =
    envelope && typeof envelope === "object" && "error" in envelope
      ? (envelope as { error?: unknown }).error
      : undefined;
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code =
    typeof record.code === "string" && ERROR_CODES.has(record.code) ? record.code : fallbackCode;
  const message = typeof record.message === "string" ? record.message : undefined;
  const details =
    record.details && typeof record.details === "object"
      ? (record.details as Record<string, unknown>)
      : undefined;
  const detailCode =
    typeof details?.code === "string" && DETAIL_CODE.test(details.code) ? details.code : null;
  const controlCode =
    typeof details?.controlFailureCode === "string" && CONTROL_CODE.test(details.controlFailureCode)
      ? `control:${details.controlFailureCode}`
      : null;
  return {
    code,
    reason:
      rejectionReasonFromMessage(message) ??
      detailCode ??
      controlCode ??
      UNCLASSIFIED_REJECTION_REASON,
    ...(message ? { fingerprint: rejectionFingerprint(message) } : {}),
  };
}

/** Classify a thrown error that escaped the central error handler. */
export function httpRejectionFactsFromError(
  error: unknown,
  fallbackCode: string,
): HttpRejectionFacts {
  const message = error instanceof Error ? error.message : undefined;
  return {
    code: fallbackCode,
    reason: rejectionReasonFromMessage(message) ?? UNCLASSIFIED_REJECTION_REASON,
    ...(message ? { fingerprint: rejectionFingerprint(message) } : {}),
  };
}

/**
 * Read a small JSON error body without consuming the response that is sent to
 * the client. Streams, non-JSON bodies, and large bodies are never read.
 */
export async function readRejectionEnvelope(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
    return undefined;
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_ENVELOPE_BYTES) return undefined;
  try {
    const text = await response.clone().text();
    if (text.length > MAX_ENVELOPE_BYTES) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
