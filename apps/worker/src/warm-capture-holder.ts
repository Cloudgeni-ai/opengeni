import type { LeaseSnapshot } from "@opengeni/db";

/** Physical capture retention is not permission to heartbeat or execute a closed turn. */
export function retainsHolderForWarmCapture(
  lease: Pick<LeaseSnapshot, "liveness" | "leaseEpoch" | "archiveCapture"> | null,
  expectedEpoch: number,
  now = Date.now(),
): boolean {
  return Boolean(
    lease?.liveness === "warm" &&
    lease.leaseEpoch === expectedEpoch &&
    lease.archiveCapture &&
    lease.archiveCapture.deadlineAt.getTime() > now,
  );
}
