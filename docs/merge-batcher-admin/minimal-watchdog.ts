/** Small liveness trigger. OFF remains the sole authority for drain and restoration. */
export type Status = {
  state: "running" | "holding" | "draining" | "stopped";
  controlObservedAt: number | null;
  consecutiveUnclassifiedFailures: number;
};
export type Reason = "stopped" | "crash-loop" | "stale" | "unavailable";
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
  return now - s.controlObservedAt! >= 900_000 ? "stale" : null;
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
