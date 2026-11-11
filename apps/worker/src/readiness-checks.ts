/**
 * Shared readiness reporting for the dedicated artifact sidecars. Each probe
 * settles independently so `/readyz` names the dependency that actually failed,
 * and a transition log makes a readiness change visible when it happens.
 */

export type ReadinessCheckResult = Readonly<{ ok: true } | { ok: false; reason: string }>;

export type ReadinessChecks = Readonly<Record<string, ReadinessCheckResult>>;

const MAX_REASON_LENGTH = 600;

/** A dedicated database role that can do more than its narrow capability allows. */
export class UnsafeDatabaseRolePostureError extends Error {
  constructor(
    readonly component: string,
    readonly violations: readonly string[],
  ) {
    super(`${component} database connection has an unsafe role posture: ${violations.join("; ")}`);
    this.name = "UnsafeDatabaseRolePostureError";
  }
}

export function readinessFailureReason(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : "check failed";
  const singleLine = raw.replace(/\s+/g, " ").trim() || "check failed";
  return singleLine.length > MAX_REASON_LENGTH
    ? `${singleLine.slice(0, MAX_REASON_LENGTH - 1)}…`
    : singleLine;
}

/** Settle one probe; an aborted signal reports a timeout instead of waiting. */
export async function settleReadinessCheck(
  probe: () => Promise<unknown>,
  signal?: AbortSignal,
): Promise<ReadinessCheckResult> {
  if (signal?.aborted) return { ok: false, reason: "timed out" };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<ReadinessCheckResult>((resolve) => {
    onAbort = () => resolve({ ok: false, reason: "timed out" });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      (async (): Promise<ReadinessCheckResult> => {
        try {
          await probe();
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: readinessFailureReason(error) };
        }
      })(),
      aborted,
    ]);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export function readinessChecksOk(checks: ReadinessChecks): boolean {
  return Object.values(checks).every((check) => check.ok);
}

export function notCheckedReadiness(names: readonly string[]): ReadinessChecks {
  return Object.fromEntries(names.map((name) => [name, { ok: false, reason: "not checked yet" }]));
}

/** The error a failed startup readiness check raises, naming every failing probe. */
export class ReadinessCheckFailedError extends Error {
  constructor(
    component: string,
    readonly checks: ReadinessChecks,
  ) {
    super(`${component} is not ready: ${describeFailingChecks(checks)}`);
    this.name = "ReadinessCheckFailedError";
  }
}

export function describeFailingChecks(checks: ReadinessChecks): string {
  return Object.entries(checks)
    .filter(([, check]) => !check.ok)
    .map(([name, check]) => `${name}: ${check.ok ? "ok" : check.reason}`)
    .join("; ");
}

export type ReadinessTransitionLogger = Readonly<{
  warn(message: string): void;
  info(message: string): void;
}>;

/**
 * Log a readiness change once when it starts, when the failure changes, and when
 * it recovers. Repeated identical probe results stay quiet so a probe polled
 * every few seconds cannot flood the log.
 */
export function createReadinessTransitionRecorder(
  component: string,
  logger: ReadinessTransitionLogger,
): (checks: ReadinessChecks) => void {
  let previous: string | null = null;
  return (checks) => {
    const failing = readinessChecksOk(checks) ? "" : describeFailingChecks(checks);
    if (failing === previous) return;
    const wasFailing = previous !== null && previous !== "";
    previous = failing;
    if (failing) {
      logger.warn(`${component} readiness check failing: ${failing}`);
    } else if (wasFailing) {
      logger.info(`${component} readiness check recovered`);
    }
  };
}
