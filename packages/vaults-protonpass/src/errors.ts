import { VaultProviderError } from "./contract";
import type { ProcessResult } from "./runner";

/**
 * pass-cli 2.4.2 prints anyhow errors as `Error: <context>\n\nCaused by:\n …`.
 * API failures surface as `Could not perform operation. Reason: <ProtonApiErrorCode>`
 * (pass/src/macros.rs `assert_response!`) or `Invalid status code: <status>`.
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

/** True when stderr shows the server answered (so the outcome is known). */
export function hasServerVerdict(stderr: string): boolean {
  return protonReason(stderr) !== null || protonStatus(stderr) !== null;
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
 * verdict inside the mutation's own error context (`Error creating …`,
 * `Error trashing item`) or a pre-flight marker counts; a timeout, a signal,
 * a cancelled call or an error after the request (for example the agent
 * monitor event sent after a create) leaves the outcome unknown.
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
  return mutationContext.test(stderr) && hasServerVerdict(stderr);
}

export function outcomeUnknown(subject: string): VaultProviderError {
  return new VaultProviderError(
    "provider_outcome_unknown",
    `Proton Pass may or may not have completed "${subject}"; check the vault before retrying`,
  );
}
