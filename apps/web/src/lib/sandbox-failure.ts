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

/** A known no-compute route has no checkpoint to restore. Unknown routes stay gated. */
export function needsSandboxRecoveryCheck(
  route: { sandboxBackend?: string; activeSandboxId?: string | null },
  structuralFailure = false,
): boolean {
  return structuralFailure || route.sandboxBackend !== "none" || route.activeSandboxId !== null;
}
