/**
 * Provider sandbox failure classification.
 *
 * This is deliberately structural and fail-closed. In particular, DNS failures
 * often contain the word "not found" (`ENOTFOUND`) while gRPC reports a missing
 * sandbox as status 5 (`NOT_FOUND`) and a transient command-router outage as
 * status 14 (`UNAVAILABLE`). Treating all three as a string-matched NotFound is
 * the exact wrong failure direction: it licenses a rival box.
 */
export type ProviderSandboxFailureKind = "not_found" | "transient_transport" | "other";

export type ProviderSandboxFailure = {
  kind: ProviderSandboxFailureKind;
  /** A bounded, non-secret diagnostic suitable for logs/tests. */
  diagnostic: string;
};

const GRPC_NOT_FOUND = 5;
const GRPC_TRANSIENT = new Set([1, 2, 4, 13, 14]);
const TRANSIENT_CODES = new Set([
  "CANCELLED",
  "UNKNOWN",
  "DEADLINE_EXCEEDED",
  "INTERNAL",
  "UNAVAILABLE",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
]);
const NOT_FOUND_CODES = new Set(["404", "NOT_FOUND", "RESOURCE_NOT_FOUND", "SANDBOX_NOT_FOUND"]);

type ErrorSignals = {
  numbers: number[];
  codes: string[];
  messages: string[];
};

const SAFE_CODE = /^[A-Z0-9._:-]{1,64}$/;

function safeRead(record: object, key: string): unknown {
  try {
    return Reflect.get(record, key);
  } catch {
    // Provider errors can carry hostile getters/proxies. Classification must
    // fail closed rather than replacing the original failure with a getter
    // exception.
    return undefined;
  }
}

function collectSignals(value: unknown): ErrorSignals {
  const out: ErrorSignals = { numbers: [], codes: [], messages: [] };
  const seen = new Set<object>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > 3 || current === null || current === undefined) return;
    if (typeof current === "string") {
      out.messages.push(current);
      return;
    }
    if (typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    for (const key of [
      "status",
      "statusCode",
      "httpStatus",
      "httpStatusCode",
      "responseStatus",
      "errorCode",
      "code",
    ]) {
      const signal = safeRead(current, key);
      if (typeof signal === "number" && Number.isFinite(signal)) out.numbers.push(signal);
      if (typeof signal === "string") {
        const code = signal.trim().toUpperCase();
        if (SAFE_CODE.test(code)) out.codes.push(code);
      }
    }
    for (const key of ["name", "message", "details", "cause"]) {
      const signal = safeRead(current, key);
      // Retain only bounded strings for exact grammar matching below. They are
      // never copied into the diagnostic or any product payload.
      if (typeof signal === "string" && signal.length <= 512) out.messages.push(signal);
      else visit(signal, depth + 1);
    }
    visit(safeRead(current, "response"), depth + 1);
    visit(safeRead(current, "error"), depth + 1);
  };
  visit(value, 0);
  return out;
}

function safeDiagnostic(signals: ErrorSignals): string {
  const code = signals.codes.find(Boolean);
  const numeric = signals.numbers.find((value) => Number.isFinite(value));
  return [code ? `code=${code}` : "", numeric !== undefined ? `status=${numeric}` : ""]
    .filter(Boolean)
    .join(" ");
}

/**
 * Classify a provider control failure without broad message matching.
 *
 * Typed status/code evidence wins. The sole message-only gone cases are Modal's
 * exact `resume()` terminal-state errors: the SDK has already resolved the
 * exact sandbox id and `poll()` returned a non-null exit code. Keep these
 * anchored to the SDK's emitted grammar; generic "not found" text (including
 * DNS `ENOTFOUND`) stays non-authoritative. Unknown errors stay `other`, which
 * means no recreate.
 */
export function classifyProviderSandboxFailure(
  backendId: string,
  error: unknown,
): ProviderSandboxFailure {
  if (backendId === "selfhosted" || !error) {
    return { kind: "other", diagnostic: "selfhosted-or-empty" };
  }
  const signals = collectSignals(error);
  const diagnostic = safeDiagnostic(signals) || "unclassified_provider_failure";

  // HTTP 404 / gRPC NOT_FOUND / exact symbolic codes are provider identity
  // evidence. Check transient DNS codes first: ENOTFOUND is DNS, not a box 404.
  if (signals.codes.some((code) => TRANSIENT_CODES.has(code))) {
    return { kind: "transient_transport", diagnostic };
  }
  if (signals.numbers.some((status) => GRPC_TRANSIENT.has(status))) {
    return { kind: "transient_transport", diagnostic };
  }
  if (
    signals.numbers.some((status) => status === 404 || status === GRPC_NOT_FOUND) ||
    signals.codes.some((code) => NOT_FOUND_CODES.has(code))
  ) {
    return { kind: "not_found", diagnostic };
  }

  if (
    backendId === "modal" &&
    signals.messages.some(
      (message) =>
        /^Modal sandbox [A-Za-z0-9_-]+ is no longer running\.$/.test(message) ||
        /^Modal sandbox [A-Za-z0-9_-]+ not found \(has been terminated\)$/.test(message),
    )
  ) {
    return {
      kind: "not_found",
      diagnostic:
        diagnostic === "unclassified_provider_failure"
          ? "modal_terminal_message"
          : `${diagnostic} modal_terminal_message`,
    };
  }

  return { kind: "other", diagnostic };
}

export function isProviderSandboxNotFoundError(backendId: string, error: unknown): boolean {
  return classifyProviderSandboxFailure(backendId, error).kind === "not_found";
}

export function isProviderSandboxTransientError(backendId: string, error: unknown): boolean {
  return classifyProviderSandboxFailure(backendId, error).kind === "transient_transport";
}
