import { VaultProviderError } from "./contract";
import type { ProcessResult } from "./runner";

/**
 * pass-cli 2.4.2 prints anyhow errors as `Error: <context>\n\nCaused by:\n …`.
 * API failures surface as `Could not perform operation. Reason: <ProtonApiErrorCode>`
 * (pass/src/macros.rs `assert_response!`) or `Invalid status code: <status>`.
 * The reason form appears whenever a non-2xx body carries a `Code` that
 * pass/src/error.rs `ProtonApiErrorCode` knows, whatever the HTTP status, so
 * a reason alone does not prove a 4xx; the status form appears otherwise.
 * stderr is never returned to callers; only the classification below is.
 */
const REASON = /Could not perform operation\. Reason: ([A-Za-z]+)/;
const STATUS = /Invalid status code(?: for download chunk)?: (\d{3})/;

/** The session can no longer be used; a fresh login is required. */
export const SESSION_INVALIDATED = /Your session has been invalidated/;
/** Pre-flight: the CLI found no usable session before contacting the API. */
export const NOT_AUTHENTICATED = /This operation requires an authenticated client/;

const NOT_FOUND =
  /Item not found|Share with id \S+ not found|Could not find vault|Could not find item|Attachment not found/;
const NETWORK =
  /error sending request|dns error|failed to lookup address|Connection refused|connection (?:reset|closed)|operation timed out|tcp connect error|certificate/i;

const PERMISSION_REASONS = new Set([
  "PermissionDenied",
  "NotAllowed",
  "InsufficientScope",
  "AdminPermissionMissing",
  "Banned",
  "FeatureDisabled",
]);
const NOT_FOUND_REASONS = new Set(["NotExists", "DeletedShare"]);
const CONFLICT_REASONS = new Set(["NotLatestRevision", "NotLatestKey", "AlreadyExists"]);
const QUOTA_REASONS = new Set(["NoQuotaLeft", "ResourceLimitExceeded", "PayloadTooLarge"]);

/** The Proton API error code name in stderr, if any (a closed enum, safe to report). */
export function protonReason(stderr: string): string | null {
  return REASON.exec(stderr)?.[1] ?? null;
}

export function protonStatus(stderr: string): number | null {
  const match = STATUS.exec(stderr);
  return match ? Number(match[1]) : null;
}

/**
 * Statuses with which Proton refuses a request before applying it: a bad or
 * invalid request (400, 422), an unauthorised or forbidden one (401, 403), a
 * missing target (404), a conflict (409), an oversized payload (413) or
 * throttling (429). Any other status (500, 502, 503, 504 from Proton or a
 * proxy, or anything unexpected) may follow an applied change.
 */
export const PROTON_DEFINITE_REJECTION_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 409, 413, 422, 429,
]);

/**
 * `ProtonApiErrorCode` names (pass-cli 2.4.2 pass/src/error.rs) that describe
 * a refusal of the request itself: permission, a missing or deleted target, a
 * stale revision or key, a lock, a quota, or invalid input. Server-side
 * failures that may follow a partial write (`Timeout`, `InsertFailed`,
 * `SelectFailed`, `UploadFailure`, the `Provider*` family) and any name not
 * listed here leave a mutation's outcome unknown.
 */
export const PROTON_DEFINITE_REJECTION_REASONS: ReadonlySet<string> = new Set([
  ...PERMISSION_REASONS,
  ...NOT_FOUND_REASONS,
  ...CONFLICT_REASONS,
  ...QUOTA_REASONS,
  "SessionLocked",
  "IsLocked",
  "InvalidSignature",
  "MissingKeys",
  "RotationPayloadIncomplete",
  "IncompatibleState",
  "BadLockId",
  "InvalidRequirements",
  "InvalidValue",
  "InvalidType",
  "ValueOutOfBounds",
  "NotNull",
  "NotEmpty",
  "NotTrue",
  "NotFalse",
  "NotEqual",
  "Equal",
  "NotSameAsField",
  "RegexError",
  "InvalidNumber",
  "InvalidLength",
  "TooShort",
  "TooLong",
  "HashNotEqual",
  "EmailFormat",
  "IpFormat",
  "UrlFormat",
  "CurrencyFormat",
  "LocaleFormat",
  "DateFormat",
  "JsonFormat",
  "MimeFormat",
  "PhoneFormat",
  "DomainFormat",
  "PgpFormat",
  "IdFormat",
  "HexFormat",
  "Base64Format",
  "VersionFormat",
  "ImageFormat",
]);

/**
 * True when stderr shows Proton refused the request without applying it: a
 * known rejection reason, or (when no reason was decoded) a rejection status.
 */
export function isDefiniteRejection(stderr: string): boolean {
  const reason = protonReason(stderr);
  if (reason !== null) return PROTON_DEFINITE_REJECTION_REASONS.has(reason);
  const status = protonStatus(stderr);
  return status !== null && PROTON_DEFINITE_REJECTION_STATUSES.has(status);
}

/**
 * Maps a failed pass-cli run to a provider error. `subject` names the action in
 * the message (for example "list items"); stderr content never leaves here
 * except the closed Proton error-code name.
 */
export function mapProtonFailure(result: ProcessResult, subject: string): VaultProviderError {
  if (result.spawnError) {
    return new VaultProviderError("provider_unavailable", "pass-cli could not be started");
  }
  if (result.timedOut) {
    return new VaultProviderError("provider_unavailable", `Proton Pass timed out (${subject})`);
  }
  if (result.aborted) {
    return new VaultProviderError(
      "provider_unavailable",
      `Proton Pass call cancelled (${subject})`,
    );
  }
  const stderr = result.stderr;
  if (SESSION_INVALIDATED.test(stderr) || NOT_AUTHENTICATED.test(stderr)) {
    return new VaultProviderError(
      "provider_auth_expired",
      "The Proton Pass session ended; sign in again with the personal access token",
    );
  }
  const reason = protonReason(stderr);
  if (reason) {
    if (reason === "SessionLocked" || reason === "IsLocked") {
      return new VaultProviderError("provider_locked", "The Proton Pass session is locked");
    }
    if (PERMISSION_REASONS.has(reason)) {
      return new VaultProviderError(
        "provider_permission_denied",
        `The Proton Pass token may not ${subject} (${reason})`,
      );
    }
    if (NOT_FOUND_REASONS.has(reason)) {
      return new VaultProviderError("provider_not_found", "No such Proton Pass vault or item");
    }
    if (CONFLICT_REASONS.has(reason)) {
      return new VaultProviderError(
        "provider_conflict",
        `Proton Pass rejected the change because the item changed (${reason})`,
      );
    }
    if (QUOTA_REASONS.has(reason)) {
      return new VaultProviderError(
        "provider_unavailable",
        `Proton Pass refused the request: account limit reached (${reason})`,
      );
    }
    return new VaultProviderError(
      "provider_unavailable",
      `Proton Pass rejected the request (${reason})`,
    );
  }
  const status = protonStatus(stderr);
  if (status !== null) {
    if (status === 429) {
      return new VaultProviderError(
        "provider_rate_limited",
        "Proton Pass is rate limiting",
        60_000,
      );
    }
    if (status === 401) {
      return new VaultProviderError("provider_auth_expired", "The Proton Pass session expired");
    }
    if (status === 403) {
      return new VaultProviderError(
        "provider_permission_denied",
        `The Proton Pass token may not ${subject}`,
      );
    }
    if (status === 404) {
      return new VaultProviderError("provider_not_found", "No such Proton Pass vault or item");
    }
    if (status === 409) {
      return new VaultProviderError("provider_conflict", "Proton Pass reported a conflict");
    }
    return new VaultProviderError("provider_unavailable", `Proton Pass returned HTTP ${status}`);
  }
  if (NOT_FOUND.test(stderr)) {
    return new VaultProviderError("provider_not_found", "No such Proton Pass vault or item");
  }
  if (NETWORK.test(stderr)) {
    return new VaultProviderError("provider_unavailable", "Proton Pass could not be reached");
  }
  return new VaultProviderError("provider_unavailable", `Proton Pass could not ${subject}`);
}

/**
 * Markers proving a mutation failed before anything was sent: bad input, no
 * session, or the agent-reason check (`ensure_reason_if_agent`) that runs first.
 */
const PRE_FLIGHT =
  /Error parsing JSON|Error parsing template JSON|Error reading (?:from stdin|template)|Error converting template|requires an authenticated client|Agent sessions must set the PROTON_PASS_AGENT_REASON|PROTON_PASS_AGENT_REASON is (?:set but empty|too long)|Invalid field type|Invalid timestamp value|Please provide either|Error creating trash item request|Could not find vault|Share with id \S+ not found/;

/**
 * Whether a failed mutation is known not to have taken effect. Only a server
 * rejection inside the mutation's own error context (`Error creating …`,
 * `Error trashing item`) with a known rejection reason or status, or a
 * pre-flight marker, counts. A server error (500, 502, 503, 504 or any other
 * status or reason outside the rejection sets), a timeout, a signal, a
 * cancelled call or an error after the request (for example the agent monitor
 * event sent after a create) leaves the outcome unknown.
 */
export function isDefiniteMutationFailure(result: ProcessResult, mutationContext: RegExp): boolean {
  if (result.spawnError) return true;
  if (result.timedOut || result.aborted || result.signal !== null || result.stdoutOverflow) {
    return false;
  }
  if (result.exitCode === null) return false;
  const stderr = result.stderr;
  if (SESSION_INVALIDATED.test(stderr)) return false;
  if (PRE_FLIGHT.test(stderr)) return true;
  return mutationContext.test(stderr) && isDefiniteRejection(stderr);
}

export function outcomeUnknown(subject: string): VaultProviderError {
  return new VaultProviderError(
    "provider_outcome_unknown",
    `Proton Pass may or may not have completed "${subject}"; check the vault before retrying`,
  );
}

/** pass-cli's context for a token login the API answered (`Error logging in with personal access token`). */
const LOGIN_CONTEXT = /Error logging in with personal access token/;
/** Statuses with which Proton's API refuses the token itself. */
const LOGIN_REJECTED_STATUSES = new Set([400, 401, 403, 422]);

/**
 * Maps a failed `pass-cli login`. Only Proton's own refusal of the token
 * (a 400, 401, 403 or 422 answer, or a permission or not-found reason, in
 * the token-login context) asks the customer for a new token. Local
 * failures (key provider, disk, an unexpected CLI error), network trouble,
 * throttling and server errors are `provider_unavailable` or
 * `provider_rate_limited`; reconnecting would not help with them.
 */
export function loginFailure(result: ProcessResult): VaultProviderError {
  const stderr = result.stderr;
  const answered =
    !result.spawnError && !result.timedOut && !result.aborted && LOGIN_CONTEXT.test(stderr);
  if (answered) {
    const status = protonStatus(stderr);
    const reason = protonReason(stderr);
    if (
      (status !== null && LOGIN_REJECTED_STATUSES.has(status)) ||
      (reason !== null && (PERMISSION_REASONS.has(reason) || NOT_FOUND_REASONS.has(reason)))
    ) {
      return new VaultProviderError(
        "provider_auth_invalid",
        "Proton Pass rejected the personal access token (revoked, expired or mistyped)",
      );
    }
  }
  const mapped = mapProtonFailure(result, "sign in");
  // Outside the API's verdict on the token, no other mapping (expired
  // session, permission, not found) describes a failed login accurately.
  if (mapped.code === "provider_rate_limited") return mapped;
  if (mapped.code === "provider_unavailable") return mapped;
  return new VaultProviderError("provider_unavailable", "Proton Pass could not sign in");
}
