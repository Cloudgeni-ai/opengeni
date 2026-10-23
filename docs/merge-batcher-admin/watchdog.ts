/** Portable watchdog policy. No credentials, timers, provider calls or ON path. */
export type Binding = {
  deploymentUid: string;
  image: string;
  activation: string;
  planDigest: string;
};
export type Observation = {
  binding: Binding;
  observedAt: number;
  activatedAt: number;
  lastHealthyAt: number | null;
  revision: string;
  stopped: boolean;
  crashLoop: boolean;
  writes: "idle" | "inflight" | "unknown";
  policy: "applied" | "manual" | "drift";
};
export type Trigger = "stopped" | "crash-loop" | "stale-health";
export type Record = {
  schema: 1;
  binding: Binding;
  phase: "watching" | "off-intent" | "manual" | "held";
  incident: { id: string; runId: string; trigger: Trigger; observationRevision: string } | null;
  receipt: string | null;
  notification: "none" | "intent" | "sent";
  notificationRunId: string | null;
  reason: string | null;
};
export type Stored = { version: string; value: Record };
export type Heartbeat = {
  runId: string;
  at: number;
  stage: "started" | "finished";
  outcome: string;
};
/** The provider adapter must implement remote generation-match CAS, not a local lock. */
export type Ports = {
  now(): number;
  read(): Promise<Observation>;
  load(): Promise<Stored | null>;
  cas(version: string | null, next: Record): Promise<string | null>;
  heartbeat(event: Heartbeat): Promise<void>;
  /** Provider execution status, not a time-expiring ownership lease. */
  execution(runId: string): Promise<"running" | "terminal" | "unknown">;
  /** Fence the exact activation, then invoke reviewed OFF. Return only after its
   * real STOP + exact saved-policy verifier passes. Never accept a status string. */
  off(expected: Observation, incidentId: string): Promise<string>;
  /** Read-only reconciliation: verify the same real receipt and current policy.
   * Null means unknown/incomplete; it is NOT permission to retry OFF. */
  reconcile(expected: Binding, incidentId: string): Promise<string | null>;
  /** first may POST once. reconcile is read-only and must never POST if absent.
   * Return false on an unknown outcome; retain the intent for operator resolution. */
  notify(
    id: string,
    reason: string,
    receipt: string | null,
    mode: "first" | "reconcile",
  ): Promise<boolean>;
  /** Independent monitoring/log alert, not an unjournalled public-comment POST. */
  alert(reason: string): Promise<void>;
};
export const staleAfterMs = 15 * 60_000;
export const maxObservationAgeMs = 120_000;

function same(a: Binding, b: Binding): boolean {
  return (
    a.deploymentUid === b.deploymentUid &&
    a.image === b.image &&
    a.activation === b.activation &&
    a.planDigest === b.planDigest
  );
}
function validBinding(b: Binding): boolean {
  return (
    !!b &&
    typeof b.deploymentUid === "string" &&
    b.deploymentUid.length > 0 &&
    typeof b.activation === "string" &&
    b.activation.length > 0 &&
    typeof b.image === "string" &&
    /@sha256:[a-f0-9]{64}$/.test(b.image) &&
    typeof b.planDigest === "string" &&
    /^[a-f0-9]{64}$/.test(b.planDigest)
  );
}
export function classify(
  o: Observation,
  expected: Binding,
  now: number,
): Trigger | "healthy" | "manual" | "unknown" {
  if (
    !o ||
    !validBinding(expected) ||
    !validBinding(o.binding) ||
    !same(o.binding, expected) ||
    !Number.isFinite(now) ||
    !Number.isFinite(o.observedAt) ||
    o.observedAt > now ||
    now - o.observedAt > maxObservationAgeMs ||
    !Number.isFinite(o.activatedAt) ||
    o.activatedAt > o.observedAt ||
    typeof o.revision !== "string" ||
    !o.revision ||
    typeof o.stopped !== "boolean" ||
    typeof o.crashLoop !== "boolean" ||
    !["idle", "inflight", "unknown"].includes(o.writes) ||
    !["applied", "manual", "drift"].includes(o.policy) ||
    (o.lastHealthyAt !== null &&
      (!Number.isFinite(o.lastHealthyAt) ||
        o.lastHealthyAt < o.activatedAt ||
        o.lastHealthyAt > o.observedAt))
  )
    return "unknown";
  if (o.policy === "drift" || o.writes === "unknown") return "unknown";
  if (o.policy === "manual") return "manual";
  if (o.stopped) return "stopped";
  if (o.crashLoop) return "crash-loop";
  return now - (o.lastHealthyAt ?? o.activatedAt) >= staleAfterMs ? "stale-health" : "healthy";
}

/** One bounded invocation. A lost/unfinished action claim is never timed out and
 * stolen: its effect must first be reconciled. There is deliberately no ON. */
export async function tick(ports: Ports, expected: Binding, runId: string): Promise<string> {
  if (!validBinding(expected) || !runId) throw Error("Pinned activation and run identity required");
  await ports.heartbeat({ runId, at: ports.now(), stage: "started", outcome: "observing" });
  let stored = await ports.load();
  if (!stored) {
    const value: Record = {
      schema: 1,
      binding: expected,
      phase: "watching",
      incident: null,
      receipt: null,
      notification: "none",
      notificationRunId: null,
      reason: null,
    };
    const version = await ports.cas(null, value);
    if (version === null) return finish("cas-lost");
    stored = { version, value };
  }
  if (
    stored.value.schema !== 1 ||
    !validBinding(stored.value.binding) ||
    !same(stored.value.binding, expected) ||
    !["watching", "off-intent", "manual", "held"].includes(stored.value.phase) ||
    !["none", "intent", "sent"].includes(stored.value.notification) ||
    (stored.value.phase === "off-intent" &&
      (!stored.value.incident?.id || !stored.value.incident.runId)) ||
    (stored.value.phase === "manual" && !stored.value.receipt)
  ) {
    await ports.alert("Unknown watchdog record/binding; no writes");
    return finish("binding-hold");
  }
  let { version, value } = stored;
  async function save(next: Record): Promise<boolean> {
    const changed = await ports.cas(version, next);
    if (changed === null) return false;
    version = changed;
    value = next;
    return true;
  }
  async function finish(outcome: string): Promise<string> {
    await ports.heartbeat({ runId, at: ports.now(), stage: "finished", outcome });
    return outcome;
  }
  async function notify(): Promise<string> {
    if (value.notification === "sent") return finish(value.phase);
    const first = value.notification === "none";
    if (first && !(await save({ ...value, notification: "intent", notificationRunId: runId })))
      return finish("cas-lost");
    if (!first) {
      if (
        !value.notificationRunId ||
        (await ports.execution(value.notificationRunId)) !== "terminal"
      )
        return finish("notification-in-progress-or-unknown");
    }
    const posted = await ports.notify(
      value.incident?.id ?? `${expected.activation}:health`,
      value.reason ?? value.phase,
      value.receipt,
      first ? "first" : "reconcile",
    );
    if (!posted) {
      await ports.alert("Incident notification outcome unknown; no POST retry");
      return finish("notification-unknown");
    }
    if (!(await save({ ...value, notification: "sent" }))) return finish("cas-lost");
    return finish(value.phase);
  }
  if (value.phase === "manual") {
    let current: Observation;
    try {
      current = await ports.read();
    } catch {
      await ports.alert("Saved Manual receipt cannot be freshly verified");
      return finish("manual-readback-unknown");
    }
    if (classify(current, expected, ports.now()) !== "manual") {
      await ports.alert(
        "Policy/activation changed after Manual restoration; do not reuse old OFF intent",
      );
      return finish("manual-readback-drift");
    }
    return notify();
  }
  if (value.phase === "held") return notify();
  if (value.phase === "off-intent") {
    const execution = await ports.execution(value.incident!.runId);
    if (execution === "running") return finish("off-in-progress");
    if (execution === "unknown") {
      await ports.alert("OFF execution status unknown; do not steal its claim");
      return finish("off-intent");
    }
    const receipt = await ports.reconcile(expected, value.incident!.id);
    if (
      !(await save({
        ...value,
        phase: receipt ? "manual" : "held",
        receipt,
        reason: receipt
          ? "Restored saved Manual policy"
          : "Unfinished OFF outcome; operator reconciliation required",
      }))
    )
      return finish("cas-lost");
    return notify();
  }
  let observation: Observation;
  try {
    observation = await ports.read();
  } catch {
    if (
      !(await save({
        ...value,
        phase: "held",
        reason: "Health read unavailable; no restoration proof",
      }))
    )
      return finish("cas-lost");
    return notify();
  }
  const trigger = classify(observation, expected, ports.now());
  if (trigger === "healthy" || trigger === "manual") return finish(trigger);
  if (trigger === "unknown") {
    if (
      !(await save({
        ...value,
        phase: "held",
        reason: "Unknown health/write state or policy drift; no automatic restore",
      }))
    )
      return finish("cas-lost");
    return notify();
  }
  const incident = {
    id: `${expected.activation}:${runId}`,
    runId,
    trigger,
    observationRevision: observation.revision,
  };
  if (!(await save({ ...value, phase: "off-intent", incident }))) return finish("cas-lost");
  // Revalidate after the exclusive action claim. Adapter must also bind/fence the
  // activation remotely; this read is not claimed as an atomic provider fence.
  let current: Observation;
  try {
    current = await ports.read();
  } catch {
    await ports.alert("Health reread unavailable after claim; no OFF executed");
    return finish("off-intent");
  }
  if (
    current.revision !== observation.revision ||
    classify(current, expected, ports.now()) !== trigger
  ) {
    if (
      !(await save({
        ...value,
        phase: "held",
        reason: "Observation changed after claim; no OFF executed",
      }))
    )
      return finish("cas-lost");
    return notify();
  }
  let receipt: string;
  try {
    receipt = await ports.off(current, incident.id);
  } catch {
    // Keep the pre-effect intent. Next invocation performs read-only reconciliation.
    await ports.alert("OFF incomplete or unknown; protections retained until verified");
    return finish("off-intent");
  }
  if (!receipt) throw Error("OFF verifier returned no retained receipt");
  if (
    !(await save({
      ...value,
      phase: "manual",
      receipt,
      reason: `${trigger}: restored saved Manual policy`,
    }))
  )
    return finish("cas-lost");
  return notify();
}

/** Called by a separately scheduled observer, never by the watchdog itself.
 * Run-completion heartbeat is required; a fresh start cannot hide a hung run. */
export function missedRuns(lastFinishedAt: number | null, enabledAt: number, now: number): boolean {
  return (
    !Number.isFinite(now) ||
    !Number.isFinite(enabledAt) ||
    enabledAt > now ||
    (lastFinishedAt !== null &&
      (!Number.isFinite(lastFinishedAt) || lastFinishedAt > now || lastFinishedAt < enabledAt)) ||
    now - (lastFinishedAt ?? enabledAt) >= staleAfterMs
  );
}
