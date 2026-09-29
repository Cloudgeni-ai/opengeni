import type { LeaseSnapshot, SandboxRetainedProcess } from "@opengeni/db";

/** Observation backoff must leave the exact provider's rotation window usable.
 * This changes only the next probe time, never cancellation or settlement proof. */
export function retainedProcessDeadlineRetryMs(
  process: Pick<
    SandboxRetainedProcess,
    "leaseId" | "leaseEpoch" | "providerBackend" | "providerInstanceId" | "routeTargetId"
  >,
  lease: Pick<
    LeaseSnapshot,
    "id" | "leaseEpoch" | "backend" | "instanceId" | "providerDeadlineAt"
  > | null,
  settings: { sandboxRotationLeadMs: number; sandboxLeaseReaperPeriodMs: number },
  retryAfterMs: number,
  now = Date.now(),
): number {
  if (
    process.providerBackend !== "modal" ||
    process.routeTargetId !== null ||
    !lease ||
    lease.id !== process.leaseId ||
    lease.leaseEpoch !== process.leaseEpoch ||
    lease.backend !== process.providerBackend ||
    lease.instanceId !== process.providerInstanceId ||
    !lease.providerDeadlineAt
  )
    return retryAfterMs;

  const untilRotation = lease.providerDeadlineAt.getTime() - settings.sandboxRotationLeadMs - now;
  if (!Number.isFinite(untilRotation)) return retryAfterMs;
  return Math.min(
    retryAfterMs,
    Math.max(1_000, settings.sandboxLeaseReaperPeriodMs, untilRotation),
  );
}
