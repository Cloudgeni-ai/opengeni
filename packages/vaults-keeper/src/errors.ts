import { VaultProviderError } from "./contract";

/**
 * Keeper Secrets Manager errors as SDK 17.6.0 raises them: a non-200 response
 * becomes `new Error(<first 1000 bytes of the body>)`, where the body is JSON
 * such as `{"path":"…","result_code":"access_denied","message":"…"}` (older
 * servers use `error` for the code); an empty error body becomes
 * `unknown ksm error, code <status>`; exhausted throttle retries raise
 * `KeeperThrottleError`; request deadlines raise `KeeperError("Request to …
 * timed out after …ms")`. These shapes come from the SDK source and Keeper's
 * documentation; Keeper does not publish a complete result-code table, so the
 * message patterns below are deliberately conservative.
 */
const AUTH_HINT =
  /signature|client ?id|clientid|one[- ]?time|token|expired|ip address|ip lock|locked out|not bound|unbound|device|revoked/i;
const NOT_FOUND_HINT = /not found|does not exist|no such|unknown (?:record|folder)/i;
const CONFLICT_HINT = /revision|out of (?:date|sync)|conflict|modified/i;

export interface KeeperErrorBody {
  code: string | null;
  message: string;
  retryAfterSeconds: number | null;
}

/** Parses the JSON error body the SDK embeds in its Error message. */
export function keeperErrorBody(error: unknown): KeeperErrorBody | null {
  if (!(error instanceof Error)) return null;
  const text = error.message.trim();
  if (!text.startsWith("{")) return null;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const code = body.result_code ?? body.error;
    const retry = body.retry_after;
    return {
      code: typeof code === "string" ? code.slice(0, 64) : null,
      message: typeof body.message === "string" ? body.message : "",
      retryAfterSeconds: typeof retry === "number" && retry >= 0 ? retry : null,
    };
  } catch {
    // A body cut at 1000 bytes may not parse; fall back to the code alone.
    const code = /"(?:result_code|error)"\s*:\s*"([a-z_]{1,64})"/.exec(text)?.[1] ?? null;
    return { code, message: "", retryAfterSeconds: null };
  }
}

function safeCode(code: string | null): string {
  return code && /^[a-z0-9_]{1,64}$/i.test(code) ? code : "error";
}

export function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    /timed out after \d+ms/.test(error.message)
  );
}

/**
 * Maps any failure of a read-side operation. stderr-like SDK text never
 * leaves this function; only a closed result code may appear in messages.
 */
export function mapKeeperError(error: unknown, subject: string): VaultProviderError {
  if (error instanceof VaultProviderError) return error;
  if (error instanceof Error && error.name === "KeeperThrottleError") {
    return new VaultProviderError(
      "provider_rate_limited",
      "Keeper is rate limiting this application",
      60_000,
    );
  }
  if (isAbortLike(error)) {
    return new VaultProviderError(
      "provider_unavailable",
      `Keeper did not answer in time (${subject})`,
    );
  }
  const body = keeperErrorBody(error);
  if (body) {
    const { code, message } = body;
    if (code === "throttled") {
      return new VaultProviderError(
        "provider_rate_limited",
        "Keeper is rate limiting this application",
        (body.retryAfterSeconds ?? 60) * 1000,
      );
    }
    if (
      code === "access_denied" ||
      code === "invalid_client" ||
      code === "invalid_client_version"
    ) {
      if (code !== "access_denied" || AUTH_HINT.test(message)) {
        return new VaultProviderError(
          "provider_auth_invalid",
          "Keeper rejected this application's credentials; reconnect with a new one-time token",
        );
      }
      if (NOT_FOUND_HINT.test(message)) {
        return new VaultProviderError(
          "provider_not_found",
          "No such Keeper shared folder or record",
        );
      }
      return new VaultProviderError(
        "provider_permission_denied",
        `The Keeper application may not ${subject}`,
      );
    }
    if (
      NOT_FOUND_HINT.test(message) ||
      (code && /not_found|invalid_record|record_uid/.test(code))
    ) {
      return new VaultProviderError("provider_not_found", "No such Keeper shared folder or record");
    }
    if (CONFLICT_HINT.test(message) || (code && /revision|conflict/.test(code))) {
      return new VaultProviderError(
        "provider_conflict",
        "The Keeper record changed since it was read; read it again before writing",
      );
    }
    return new VaultProviderError(
      "provider_unavailable",
      `Keeper rejected the request (${safeCode(code)})`,
    );
  }
  const status =
    error instanceof Error ? /unknown ksm error, code (\d{3})/.exec(error.message)?.[1] : undefined;
  if (status) {
    const code = Number(status);
    if (code === 401) {
      return new VaultProviderError(
        "provider_auth_invalid",
        "Keeper rejected this application's credentials",
      );
    }
    if (code === 403) {
      return new VaultProviderError(
        "provider_permission_denied",
        `The Keeper application may not ${subject}`,
      );
    }
    if (code === 404)
      return new VaultProviderError("provider_not_found", "No such Keeper shared folder or record");
    if (code === 429)
      return new VaultProviderError(
        "provider_rate_limited",
        "Keeper is rate limiting this application",
        60_000,
      );
    return new VaultProviderError("provider_unavailable", `Keeper returned HTTP ${code}`);
  }
  return new VaultProviderError("provider_unavailable", `Keeper could not ${subject}`);
}

/** Tracks one mutation's requests so a failure can be classified as definite or unknown. */
export interface MutationTracker {
  /** Requests started for the mutation itself. */
  sent: number;
  /** Status of the last mutation response, if one arrived. */
  lastStatus: number | null;
}

/**
 * A mutation failure is definite only when nothing was sent, or Keeper
 * answered the request with an error. A transport failure, deadline or abort
 * after sending, or any failure after a 200, leaves the outcome unknown.
 */
export function mapKeeperMutationError(
  error: unknown,
  subject: string,
  tracker: MutationTracker,
): VaultProviderError {
  const definite =
    tracker.sent === 0 || (tracker.lastStatus !== null && tracker.lastStatus !== 200);
  if (!definite) {
    return new VaultProviderError(
      "provider_outcome_unknown",
      `Keeper may or may not have completed "${subject}"; check the record before retrying`,
    );
  }
  return mapKeeperError(error, subject);
}
