/**
 * Typed evidence only: error prose is not a recovery authority.
 * Keep this eager timeline predicate independent of the lazy recovery controller.
 */
export function isStructuralSandboxFailure(payload: Record<string, unknown>): boolean {
  return (
    payload.failureCategory === "archive_recovery" ||
    payload.failureCode === "restore_degraded" ||
    payload.failureCode === "unrecoverable" ||
    payload.code === "restore_degraded" ||
    payload.code === "unrecoverable"
  );
}
