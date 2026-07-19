/**
 * Provider sandbox failure classification.
 *
 * This is deliberately structural and fail-closed. DNS failures often contain
 * the word "not found" (`ENOTFOUND`) while gRPC status values are also used by
 * unrelated SDKs and command routers. A bare numeric status (including gRPC's
 * numeric 5) is therefore not enough to retire a provider instance. Only
 * authoritative, non-transient evidence may retire a provider instance and
 * license lease recovery.
 */
export type ProviderSandboxFailureKind = "not_found" | "transient_transport" | "other";

export type ProviderSandboxFailure = {
  kind: ProviderSandboxFailureKind;
  /** Bounded, non-secret diagnostic suitable for logs and lifecycle events. */
  diagnostic: string;
};

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
const SAFE_CODE = /^[A-Z0-9._:-]{1,64}$/;

type ErrorSignals = {
  numbers: number[];
  codes: string[];
  messages: string[];
};

function safeRead(record: object, key: string): unknown {
  try {
    return Reflect.get(record, key);
  } catch {
    return undefined;
  }
}

function collectSignals(value: unknown): ErrorSignals {
  const out: ErrorSignals = { numbers: [], codes: [], messages: [] };
  const seen = new Set<object>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > 3 || current === null || current === undefined) return;
    if (typeof current === "string") {
      if (current.length <= 512) out.messages.push(current);
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

/** Typed transport evidence always dominates nested/string NotFound text. */
export function classifyProviderSandboxFailure(
  backendId: string,
  error: unknown,
): ProviderSandboxFailure {
  if (backendId === "selfhosted" || !error) {
    return { kind: "other", diagnostic: "selfhosted-or-empty" };
  }
  const signals = collectSignals(error);
  const diagnostic = safeDiagnostic(signals) || "unclassified_provider_failure";

  if (signals.codes.some((code) => TRANSIENT_CODES.has(code))) {
    return { kind: "transient_transport", diagnostic };
  }
  if (signals.numbers.some((status) => GRPC_TRANSIENT.has(status))) {
    return { kind: "transient_transport", diagnostic };
  }
  if (
    signals.numbers.some((status) => status === 404) ||
    signals.codes.some((code) => NOT_FOUND_CODES.has(code))
  ) {
    return { kind: "not_found", diagnostic };
  }

  // Modal's SDK emits these exact terminal grammars after resolving one exact
  // sandbox id. Generic "not found" prose is intentionally not authoritative.
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
