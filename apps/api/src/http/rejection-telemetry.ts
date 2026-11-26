import { createHash } from "node:crypto";
import { ErrorCode, Permission, signedDelegatedAccessTokenClaims } from "@opengeni/contracts";
import {
  messageFingerprint,
  normalizeFingerprintMessage,
  turnExecutionTelemetryKey,
} from "@opengeni/observability";
import { SITE_GATEWAY_REFUSAL_REASONS } from "../site-publishing/gateway-signature";

/**
 * Bounded, content-free classification of a rejected (4xx/5xx) API response,
 * so a refused request can be diagnosed from logs and counted per route without
 * copying the response message, identifiers, or user content into telemetry.
 *
 * - `code` is the public `ErrorEnvelope.code` (a closed enum).
 * - `reason` is `permission:<name>` when the refusal names a missing permission
 *   from the closed permission catalog (as `details.permission`, or in a
 *   legacy "missing permission: <name>" message), else the envelope's typed
 *   `details.code` when it is a short identifier, else `control:<code>` for a
 *   Connected Machine control failure, else (for a route's own top-level
 *   `{ code, message, details }` body, such as session create) its
 *   UPPER_SNAKE route code, else `unclassified`.
 * - `fingerprint` is a one-way hash of the message with identifiers and
 *   numbers normalized away. It groups identical refusals in logs; resolve it
 *   back to source text with `bun run scripts/resolve-rejection-fingerprint.ts`.
 *   It never becomes a metric label.
 * - `detail` is the closed sub-reason of a refusal whose reason has one (a
 *   site-runtime gateway signature refusal: `missing_headers`, `skew`, ...).
 *   Logged only, never a metric label.
 */
export type HttpRejectionFacts = {
  code: string;
  reason: string;
  fingerprint?: string;
  detail?: string;
};

const ERROR_CODES: ReadonlySet<string> = new Set(ErrorCode.options);
const PERMISSIONS: ReadonlySet<string> = new Set(Permission.options);
const DETAIL_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MISSING_PERMISSION = /^missing (?:literal )?permission: ([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)/;
const CONTROL_CODE = /^[a-z][a-z0-9_]{0,31}$/;
/** A route's own authored top-level code, such as `SESSION_CREATE_REJECTED`. */
const ROUTE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_ENVELOPE_BYTES = 32 * 1024;
/** Reasons whose `details.reason` is a closed, content-free sub-reason. */
const CLOSED_DETAIL_REASONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["site_gateway_signature_invalid", new Set<string>(SITE_GATEWAY_REFUSAL_REASONS)],
]);

export const UNCLASSIFIED_REJECTION_REASON = "unclassified";

/**
 * Who sent a refused request, without publishing an identifier or a credential,
 * so a client that keeps calling with a dead credential can be found:
 *
 * - `callerCorrelationId`: for a signed agent-attempt bearer (also an expired
 *   one), the same hashed attempt key the worker logs as `correlationId`
 *   (`turnExecutionTelemetryKey`), naming the turn attempt whose process is
 *   still calling.
 * - `callerCredentialKey`: for any other bearer, a domain-separated one-way
 *   hash that groups requests sent with the same credential.
 * - `callerAgent`: the first User-Agent product token, such as
 *   `opengeni-agent/1.2.3`.
 *
 * Log only, never a metric label.
 */
export type RejectedCallerAttributes = {
  callerCorrelationId?: string;
  callerCredentialKey?: string;
  callerAgent?: string;
};

const BEARER = /^Bearer ([^\s]{1,16384})$/;
const USER_AGENT_PRODUCT =
  /^([A-Za-z][A-Za-z0-9._-]{0,47})(?:\/([0-9A-Za-z][0-9A-Za-z.+_-]{0,31}))?(?=[\s;(]|$)/;

export async function rejectedCallerLogAttributes(
  headers: Headers,
  delegationSecret: string | undefined,
): Promise<RejectedCallerAttributes> {
  const attributes: RejectedCallerAttributes = {};
  const product = USER_AGENT_PRODUCT.exec(headers.get("user-agent")?.trim() ?? "");
  if (product) attributes.callerAgent = product[2] ? `${product[1]}/${product[2]}` : product[1]!;
  const bearer = BEARER.exec(headers.get("authorization")?.trim() ?? "")?.[1];
  if (!bearer) return attributes;
  const claims = delegationSecret
    ? await signedDelegatedAccessTokenClaims(delegationSecret, bearer).catch(() => null)
    : null;
  if (claims?.principalKind === "agent_attempt" && claims.sessionId && claims.attemptId) {
    attributes.callerCorrelationId = turnExecutionTelemetryKey(
      claims.workspaceId,
      claims.sessionId,
      claims.attemptId,
    );
  } else {
    attributes.callerCredentialKey = rejectedCredentialTelemetryKey(bearer);
  }
  return attributes;
}

/** Groups requests sent with one credential; the domain separator keeps it
 * from matching any stored credential digest. */
export function rejectedCredentialTelemetryKey(credential: string): string {
  return `cred_${createHash("sha256")
    .update("opengeni:rejected-credential-telemetry:v1\0")
    .update(credential)
    .digest("hex")
    .slice(0, 32)}`;
}

export function rejectionFingerprint(message: string): string {
  return messageFingerprint(message);
}

/** Identifiers, quoted values, and numbers never distinguish two fingerprints. */
export function normalizeRejectionMessage(message: string): string {
  return normalizeFingerprintMessage(message);
}

export function rejectionReasonFromMessage(message: string | undefined): string | null {
  if (!message) return null;
  return permissionReason(MISSING_PERMISSION.exec(message)?.[1]);
}

/** `permission:<name>` for a permission from the closed catalog, else null. */
function permissionReason(permission: unknown): string | null {
  return typeof permission === "string" && PERMISSIONS.has(permission)
    ? `permission:${permission}`
    : null;
}

/** The closed sub-reason for `reason`, from `details.reason`; never free text. */
function closedDetail(reason: string, details: Record<string, unknown> | undefined) {
  const value = details?.reason;
  return typeof value === "string" && CLOSED_DETAIL_REASONS.get(reason)?.has(value)
    ? { detail: value }
    : {};
}

/**
 * Classify a parsed `ErrorEnvelope`-shaped body. Unknown shapes still get a code.
 * A route that answers with its own top-level `{ code, message, details }`
 * (session create) is read the same way, so its refusals are not all
 * "unclassified": the reason is its typed `details.code`, else its own route
 * code, and the message is fingerprinted. Only a body whose top-level code is
 * one of our authored UPPER_SNAKE route codes counts, so a passed-through
 * upstream body can never add reason values.
 */
export function httpRejectionFactsFromEnvelope(
  envelope: unknown,
  fallbackCode: string,
): HttpRejectionFacts {
  const body = envelope && typeof envelope === "object" ? envelope : undefined;
  const routeShaped =
    body !== undefined &&
    !("error" in body) &&
    typeof (body as { code?: unknown }).code === "string" &&
    ROUTE_CODE.test((body as { code: string }).code);
  const error = routeShaped ? body : (body as { error?: unknown } | undefined)?.error;
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
  const routeCode =
    routeShaped && typeof record.code === "string" && !ERROR_CODES.has(record.code)
      ? record.code
      : null;
  const reason =
    permissionReason(details?.permission) ??
    rejectionReasonFromMessage(message) ??
    detailCode ??
    controlCode ??
    routeCode ??
    UNCLASSIFIED_REJECTION_REASON;
  return {
    code,
    reason,
    ...(message ? { fingerprint: rejectionFingerprint(message) } : {}),
    ...closedDetail(reason, details),
  };
}

/** Classify a thrown error that escaped the central error handler. */
export function httpRejectionFactsFromError(
  error: unknown,
  fallbackCode: string,
): HttpRejectionFacts {
  const message = error instanceof Error ? error.message : undefined;
  const permission =
    error && typeof error === "object" ? (error as { permission?: unknown }).permission : undefined;
  // A typed refusal (an API error, a missing sign-in) carries the same
  // `details.code` its envelope would.
  const details =
    error && typeof error === "object" ? (error as { details?: unknown }).details : undefined;
  const detailCode =
    details && typeof details === "object" ? (details as { code?: unknown }).code : undefined;
  // No `detail` here: this path logs through the failure logger, which does
  // not carry rejection attributes; refusals reach the envelope path first.
  return {
    code: fallbackCode,
    reason:
      permissionReason(permission) ??
      rejectionReasonFromMessage(message) ??
      (typeof detailCode === "string" && DETAIL_CODE.test(detailCode) ? detailCode : null) ??
      UNCLASSIFIED_REJECTION_REASON,
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
