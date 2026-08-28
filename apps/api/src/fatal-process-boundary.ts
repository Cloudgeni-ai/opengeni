import { randomUUID } from "node:crypto";
import type { Attributes, Observability, Span } from "@opengeni/observability";

export type ApiFatalEvent = "startup_failure" | "unhandled_rejection" | "uncaught_exception";
export type ApiFatalPhase = "startup" | "running";
export type ApiFatalReasonKind =
  | "bigint"
  | "boolean"
  | "error"
  | "function"
  | "null"
  | "number"
  | "object"
  | "string"
  | "symbol"
  | "undefined";

type ApiFatalObservability = Pick<Observability, "error" | "flush" | "startSpan">;

type ApiFatalProcess = {
  on: (
    event: "unhandledRejection" | "uncaughtException",
    listener: (reason: unknown) => void,
  ) => void;
  off: (
    event: "unhandledRejection" | "uncaughtException",
    listener: (reason: unknown) => void,
  ) => void;
  exit: (code: number) => void;
};

export type ApiFatalProcessBoundaryOptions = {
  process?: ApiFatalProcess;
  observability?: ApiFatalObservability;
  flushTimeoutMs?: number;
  correlationId?: () => string;
  fallbackLog?: (message: string) => void;
};

export type ApiFatalProcessBoundary = {
  attachObservability: (observability: ApiFatalObservability) => void;
  markRunning: () => void;
  reportStartupFailure: (reason: unknown) => Promise<void>;
  dispose: () => void;
};

const API_FATAL_FLUSH_TIMEOUT_MS = 1_000;
const API_FATAL_CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const FATAL_ERROR_CODES = {
  startup_failure: "api_startup_failed",
  unhandled_rejection: "api_unhandled_rejection",
  uncaught_exception: "api_uncaught_exception",
} as const;

export function installApiFatalProcessBoundary(
  options: ApiFatalProcessBoundaryOptions = {},
): ApiFatalProcessBoundary {
  const runtimeProcess = options.process ?? defaultProcessBoundary();
  const flushTimeoutMs = options.flushTimeoutMs ?? API_FATAL_FLUSH_TIMEOUT_MS;
  const correlationId = options.correlationId ?? (() => `api-fatal.${randomUUID()}`);
  const fallbackLog = options.fallbackLog ?? ((message: string) => console.error(message));
  let observability = options.observability;
  let phase: ApiFatalPhase = "startup";
  let reporting = false;

  const report = async (event: ApiFatalEvent, reason: unknown): Promise<void> => {
    if (reporting) return;
    reporting = true;

    const diagnostic = apiFatalDiagnostic(event, phase, reason, correlationId);
    const message = apiFatalMessage(diagnostic);
    const activeObservability = observability;
    try {
      if (activeObservability) {
        let logged = false;
        try {
          activeObservability.error(message, diagnostic);
          logged = true;
        } catch {
          // The fatal boundary must still report and terminate if logging is unhealthy.
        }
        if (!logged) {
          safeFallbackLog(fallbackLog, message);
        }
        try {
          const span: Span = activeObservability.startSpan("api.process.fatal", diagnostic);
          span.end({ error: true });
        } catch {
          // The synchronous log remains authoritative when span creation fails.
        }
        await flushWithin(activeObservability, flushTimeoutMs);
      } else {
        safeFallbackLog(fallbackLog, message);
      }
    } finally {
      runtimeProcess.exit(1);
    }
  };

  const onUnhandledRejection = (reason: unknown): void => {
    void report("unhandled_rejection", reason);
  };
  const onUncaughtException = (reason: unknown): void => {
    void report("uncaught_exception", reason);
  };
  runtimeProcess.on("unhandledRejection", onUnhandledRejection);
  runtimeProcess.on("uncaughtException", onUncaughtException);

  return {
    attachObservability: (value) => {
      observability = value;
    },
    markRunning: () => {
      phase = "running";
    },
    reportStartupFailure: async (reason) => {
      await report("startup_failure", reason);
    },
    dispose: () => {
      runtimeProcess.off("unhandledRejection", onUnhandledRejection);
      runtimeProcess.off("uncaughtException", onUncaughtException);
    },
  };
}

function apiFatalDiagnostic(
  event: ApiFatalEvent,
  phase: ApiFatalPhase,
  reason: unknown,
  correlationId: () => string,
): Attributes & {
  errorClass: "ApiFatalOperationError";
  errorCode: (typeof FATAL_ERROR_CODES)[ApiFatalEvent];
  origin: "api";
  phase: ApiFatalPhase;
  reasonKind: ApiFatalReasonKind;
  correlationId: string;
} {
  let safeCorrelationId = "api-fatal.fallback";
  try {
    const candidate = correlationId();
    if (API_FATAL_CORRELATION_ID_PATTERN.test(candidate)) {
      safeCorrelationId = candidate;
    }
  } catch {
    // A fixed valid fallback preserves the fatal report and nonzero exit.
  }
  return {
    errorClass: "ApiFatalOperationError",
    errorCode: FATAL_ERROR_CODES[event],
    origin: "api",
    phase,
    reasonKind: apiFatalReasonKind(reason),
    correlationId: safeCorrelationId,
  };
}

function apiFatalReasonKind(reason: unknown): ApiFatalReasonKind {
  if (reason === null) return "null";
  const kind = typeof reason;
  if (kind !== "object") return kind;
  try {
    return reason instanceof Error ? "error" : "object";
  } catch {
    return "object";
  }
}

function apiFatalMessage(diagnostic: ReturnType<typeof apiFatalDiagnostic>): string {
  return (
    `OpenGeni API fatal process failure (${diagnostic.errorCode}; ` +
    `phase=${diagnostic.phase}; reason_kind=${diagnostic.reasonKind}; ` +
    `correlation_id=${diagnostic.correlationId})`
  );
}

async function flushWithin(
  observability: Pick<Observability, "flush">,
  timeoutMs: number,
): Promise<void> {
  let flush: Promise<void>;
  try {
    flush = Promise.resolve(observability.flush()).catch(() => undefined);
  } catch {
    return;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      flush,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function safeFallbackLog(fallbackLog: (message: string) => void, message: string): void {
  try {
    fallbackLog(message);
  } catch {
    // Process termination remains mandatory even when every diagnostic sink fails.
  }
}

function defaultProcessBoundary(): ApiFatalProcess {
  return {
    on: (event, listener) => {
      if (event === "unhandledRejection") {
        process.on("unhandledRejection", listener);
      } else {
        process.on("uncaughtException", listener);
      }
    },
    off: (event, listener) => {
      if (event === "unhandledRejection") {
        process.off("unhandledRejection", listener);
      } else {
        process.off("uncaughtException", listener);
      }
    },
    exit: (code) => {
      process.exit(code);
    },
  };
}
