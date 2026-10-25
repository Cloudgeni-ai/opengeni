/** Small liveness trigger. OFF remains the sole authority for drain and restoration. */
export type Status = {
  state: "running" | "holding" | "draining" | "stopped";
  controlObservedAt: number | null;
  consecutiveUnclassifiedFailures: number;
  progressSchema: "batcher-progress/v1";
  lastSuccessfulCycleAt: number | null;
  firstObservationDeferredAt: number | null;
  consecutiveObservationDeferrals: number;
  runtimeStartedAt: number;
  cycleStartedAt: number | null;
  cycleDeadlineAt: number | null;
};
export type Reason = "stopped" | "crash-loop" | "stale" | "stalled" | "unavailable";
export function reason(status: unknown, now: number): Reason | null {
  if (!Number.isSafeInteger(now) || now < 0) throw Error("Invalid clock");
  if (!status || typeof status !== "object") return "unavailable";
  const s = status as Partial<Status>;
  if (!["running", "holding", "draining", "stopped"].includes(s.state ?? "")) return "unavailable";
  if (s.state === "stopped" || s.state === "draining") return "stopped";
  if (
    !Number.isSafeInteger(s.consecutiveUnclassifiedFailures) ||
    s.consecutiveUnclassifiedFailures! < 0
  )
    return "unavailable";
  if (s.consecutiveUnclassifiedFailures! >= 3) return "crash-loop";
  if (
    !Number.isSafeInteger(s.controlObservedAt) ||
    s.controlObservedAt! < 0 ||
    s.controlObservedAt! > now
  )
    return "unavailable";
  if (now - s.controlObservedAt! >= 900_000) return "stale";
  const timestamp = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= now;
  if (
    s.progressSchema !== "batcher-progress/v1" ||
    !Number.isSafeInteger(s.consecutiveObservationDeferrals) ||
    s.consecutiveObservationDeferrals! < 0 ||
    (s.firstObservationDeferredAt !== null && !timestamp(s.firstObservationDeferredAt)) ||
    (s.consecutiveObservationDeferrals === 0) !== (s.firstObservationDeferredAt === null)
  )
    return "unavailable";
  if (!timestamp(s.runtimeStartedAt)) return "unavailable";
  if (
    s.lastSuccessfulCycleAt !== null &&
    (!timestamp(s.lastSuccessfulCycleAt) || s.lastSuccessfulCycleAt < s.runtimeStartedAt)
  )
    return "unavailable";
  if (
    s.firstObservationDeferredAt !== null &&
    s.firstObservationDeferredAt! < (s.lastSuccessfulCycleAt ?? s.runtimeStartedAt)
  )
    return "unavailable";
  const active = s.cycleStartedAt !== null || s.cycleDeadlineAt !== null;
  if (
    active &&
    (!timestamp(s.cycleStartedAt) ||
      s.cycleStartedAt < s.runtimeStartedAt ||
      !Number.isSafeInteger(s.cycleDeadlineAt) ||
      s.cycleDeadlineAt! <= s.cycleStartedAt ||
      // Configured execution is at most one hour; supervisor outer bound adds
      // reconciliation, five control operations and termination (185 seconds).
      s.cycleDeadlineAt! - s.cycleStartedAt > 3_785_000)
  )
    return "unavailable";
  if (active && now >= s.cycleDeadlineAt!) return "stalled";
  const progressDeadline =
    s.lastSuccessfulCycleAt === null
      ? s.runtimeStartedAt + 120_000
      : s.lastSuccessfulCycleAt! + 900_000;
  // Successful idle and Batch-wait observations count; completed failed cycles,
  // read deferrals, heartbeat and nextCycleAt do not renew this deadline.
  if (now < progressDeadline) return null;
  // Only a cycle begun while progress was timely can finish within its fixed
  // bound. A new cycle after expiry cannot buy another grace period.
  return active && s.cycleStartedAt! < progressDeadline ? null : "stalled";
}

export type Ports = {
  // Authenticated provider target/config must match the retained OFF contract.
  verifyBinding(): Promise<void>;
  status(): Promise<unknown>;
  now(): number;
  // Durable, create-only per-activation exclusion. Never release after claiming:
  // a lost process/result must not cause automatic repeat of an unknown OFF.
  claim(): Promise<boolean>;
  off(): Promise<void>;
  record(event: { outcome: "healthy" | "held" | "manual"; reason?: Reason }): Promise<void>;
};
export async function tick(ports: Ports): Promise<"healthy" | "held" | "manual"> {
  await ports.verifyBinding();
  let status: unknown;
  try {
    status = await ports.status();
  } catch {
    status = null;
  }
  const cause = reason(status, ports.now());
  if (!cause) {
    await ports.record({ outcome: "healthy" });
    return "healthy";
  }
  if (!(await ports.claim())) {
    await ports.record({ outcome: "held", reason: cause });
    return "held";
  }
  try {
    // No classification of a status response can authorize Manual. The unchanged
    // OFF implementation must obtain real STOP/drain/settlement and exact rules.
    await ports.off();
  } catch {
    await ports.record({ outcome: "held", reason: cause });
    return "held";
  }
  await ports.record({ outcome: "manual", reason: cause });
  return "manual";
}
