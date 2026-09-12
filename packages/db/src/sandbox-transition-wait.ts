import {
  SANDBOX_LIFECYCLE_RETRY_HANDOFF_GRACE_MS,
  SANDBOX_LIFECYCLE_TRANSITION_MAX_WAIT_MS,
} from "@opengeni/config";

/** Observational only: expiring a caller's wait never revokes a capture fence. */
export class SandboxTransitionWaitBudget {
  private observedCapture = false;
  private currentDeadline: number;
  private readonly hardDeadline: number;

  constructor(
    private readonly waitMs: number,
    startedAt: number,
  ) {
    this.hardDeadline = startedAt + SANDBOX_LIFECYCLE_TRANSITION_MAX_WAIT_MS;
    this.currentDeadline = Math.min(this.hardDeadline, startedAt + waitMs);
  }

  get deadline(): number {
    return this.currentDeadline;
  }

  observeCapture(remainingMs: number | null | undefined, now: number): void {
    if (
      this.waitMs === 0 ||
      this.observedCapture ||
      remainingMs === null ||
      remainingMs === undefined ||
      !Number.isSafeInteger(remainingMs) ||
      remainingMs < 0 ||
      remainingMs > SANDBOX_LIFECYCLE_TRANSITION_MAX_WAIT_MS
    )
      return;

    // Honor the first observed child's frozen timeout across rolling settings
    // changes. Neither an expired claim (remaining=0) nor a replacement capture
    // can replenish the grace/budget on every poll and starve this caller.
    this.observedCapture = true;
    this.currentDeadline = Math.min(
      this.hardDeadline,
      Math.max(this.currentDeadline, now + remainingMs + SANDBOX_LIFECYCLE_RETRY_HANDOFF_GRACE_MS),
    );
  }
}
