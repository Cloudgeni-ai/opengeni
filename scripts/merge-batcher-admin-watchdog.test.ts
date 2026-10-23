import { describe, expect, test } from "bun:test";
import deployment from "../docs/merge-batcher-admin/watchdog-deployment.json";
import {
  classify,
  missedRuns,
  tick,
  staleAfterMs,
  missedCompletionAfterMs,
  type Binding,
  type Observation,
  type Ports,
  type Stored,
  type Heartbeat,
} from "../docs/merge-batcher-admin/watchdog";

const binding: Binding = {
  deploymentUid: "service-uid",
  image: `registry/image@sha256:${"a".repeat(64)}`,
  activation: "activation-1",
  planDigest: "b".repeat(64),
  configDigest: "c".repeat(64),
  serviceGeneration: "1",
  revision: "rev-1",
  repository: "Cloudgeni-ai/opengeni",
  stateRef: "refs/heads/batcher-state",
  phaseLimits: { cycle: { timeoutMs: 900_000, marginMs: 120_000 } },
};
function fixture() {
  let now = 2_000_000,
    stored: Stored | null = null,
    serial = 0;
  let observation: Observation = {
    binding,
    observedAt: now,
    activatedAt: 100_000,
    lastHealthyAt: now,
    heartbeatAt: now,
    phase: null,
    revision: "health-1",
    stopped: false,
    crashLoop: false,
    writes: "idle",
    policy: "applied",
  };
  const calls = { off: 0, reconcile: 0, read: 0, cas: 0 };
  const messages = new Map<string, string>();
  const heartbeat: Heartbeat[] = [];
  const alerts: string[] = [];
  const alertKeys: (string | undefined)[] = [];
  let providerExecution: "running" | "terminal" | "unknown" = "terminal";
  let reconciled: string | null = null;
  const ports: Ports = {
    now: () => now,
    read: async () => {
      calls.read++;
      return structuredClone(observation);
    },
    load: async () => structuredClone(stored),
    cas: async (version, value) => {
      calls.cas++;
      if (version !== (stored?.version ?? null)) return null;
      const next = String(++serial);
      stored = { version: next, value: structuredClone(value) };
      return next;
    },
    heartbeat: async (event) => {
      heartbeat.push(event);
    },
    execution: async () => providerExecution,
    off: async () => {
      calls.off++;
      observation.policy = "manual";
      return "verified-off-receipt";
    },
    reconcile: async () => {
      calls.reconcile++;
      return reconciled;
    },
    notify: async (id, reason, _receipt, mode) => {
      if (mode === "reconcile") return messages.has(id);
      messages.set(id, reason);
      return true;
    },
    alert: async (reason, incidentKey) => {
      alerts.push(reason);
      alertKeys.push(incidentKey);
    },
  };
  return {
    ports,
    calls,
    heartbeat,
    messages,
    alerts,
    alertKeys,
    observation: () => observation,
    patch: (patch: Partial<Observation>) => {
      observation = { ...observation, ...patch };
    },
    stored: () => stored,
    execution: (value: typeof providerExecution) => {
      providerExecution = value;
    },
    reconciled: (value: string | null) => {
      reconciled = value;
      if (value) observation.policy = "manual";
    },
    advance: (ms: number) => {
      now += ms;
      observation.observedAt = now;
    },
  };
}
describe("portable independent watchdog policy (fake provider, not live OFF qualification)", () => {
  test("fresh loop heartbeat covers CI/backoff liveness without forging a healthy completion", () => {
    const f = fixture();
    f.patch({ lastHealthyAt: 100_000, heartbeatAt: f.ports.now() });
    expect(classify(f.observation(), binding, f.ports.now())).toBe("healthy");
    f.advance(staleAfterMs);
    expect(classify(f.observation(), binding, f.ports.now())).toBe("stale-health");
  });
  test("fresh heartbeat cannot extend fixed phase deadline and unpinned caps hold", () => {
    const f = fixture();
    const start = f.ports.now();
    f.patch({
      phase: {
        id: "cycle-1",
        kind: "cycle",
        startedAt: start,
        deadlineAt: start + 1_020_000,
        timeoutMs: 900_000,
        marginMs: 120_000,
      },
    });
    f.advance(1_020_000);
    f.patch({ heartbeatAt: f.ports.now() });
    expect(classify(f.observation(), binding, f.ports.now())).toBe("phase-deadline");
    f.patch({
      phase: { ...f.observation().phase!, deadlineAt: start + 2_000_000, timeoutMs: 1_880_000 },
    });
    expect(classify(f.observation(), binding, f.ports.now())).toBe("unknown");
  });
  test("stale heartbeat triggers within a still-running phase; unknown writes never earn Manual", async () => {
    const f = fixture();
    const start = f.ports.now();
    f.patch({
      phase: {
        id: "cycle-1",
        kind: "cycle",
        startedAt: start,
        deadlineAt: start + 1_020_000,
        timeoutMs: 900_000,
        marginMs: 120_000,
      },
    });
    f.advance(staleAfterMs);
    expect(classify(f.observation(), binding, f.ports.now())).toBe("stale-health");
    f.patch({ writes: "unknown" });
    expect(await tick(f.ports, binding, "unknown")).toBe("observation-unknown");
    expect(f.calls.off).toBe(0);
  });
  test.each(["stopped", "crash-loop", "stale-health"] as const)(
    "%s calls OFF once and posts verified result",
    async (trigger) => {
      const f = fixture();
      f.patch(
        trigger === "stopped"
          ? { stopped: true }
          : trigger === "crash-loop"
            ? { crashLoop: true }
            : { heartbeatAt: 100_000 },
      );
      expect(classify(f.observation(), binding, f.ports.now())).toBe(trigger);
      expect(await tick(f.ports, binding, "run1")).toBe("manual");
      expect(await tick(f.ports, binding, "run2")).toBe("manual");
      expect(f.calls.off).toBe(1);
      expect(f.messages.size).toBe(1);
      expect(f.stored()!.value.receipt).toBe("verified-off-receipt");
    },
  );
  test("healthy and existing Manual make no mutation call", async () => {
    const f = fixture();
    expect(await tick(f.ports, binding, "r1")).toBe("healthy");
    f.patch({ policy: "manual", stopped: true });
    expect(await tick(f.ports, binding, "r2")).toBe("manual");
    expect(f.calls.off).toBe(0);
    expect(f.messages.size).toBe(0);
  });
  test("first-cycle age starts at durable activation, not watcher start", async () => {
    const f = fixture();
    f.patch({ lastHealthyAt: null, heartbeatAt: null, activatedAt: f.ports.now() });
    f.advance(staleAfterMs - 1);
    expect(await tick(f.ports, binding, "r1")).toBe("healthy");
    f.advance(1);
    expect(await tick(f.ports, binding, "r2")).toBe("manual");
  });
  test("inflight writes go through drain, never directly restore", async () => {
    const f = fixture();
    f.patch({ stopped: true, writes: "inflight" });
    f.ports.off = async (expected) => {
      f.calls.off++;
      expect(expected.writes).toBe("inflight");
      throw Error("drain incomplete");
    };
    expect(await tick(f.ports, binding, "r1")).toBe("off-intent");
    expect(f.stored()!.value.receipt).toBeNull();
    expect(f.alerts.length).toBe(1);
  });
  test.each([
    { writes: "unknown" as const },
    { policy: "drift" as const },
    { observedAt: 0 },
    { observedAt: 9_000_000 },
    { lastHealthyAt: 9_000_000 },
    { activatedAt: NaN },
    { revision: "" },
    { binding: { ...binding, activation: "another-activation" } },
    { binding: { ...binding, configDigest: "d".repeat(64) } },
    { binding: { ...binding, serviceGeneration: "2" } },
    { binding: { ...binding, revision: "rev-other" } },
    { binding: { ...binding, repository: "wrong/repository" } },
    { binding: { ...binding, stateRef: "refs/heads/other-state" } },
    { heartbeatAt: 9_000_000 },
  ])("pre-claim uncertainty alerts but re-observes and recovers: %j", async (patch) => {
    const f = fixture();
    const original = structuredClone(f.observation());
    f.patch({ stopped: true, ...patch });
    expect(await tick(f.ports, binding, "r1")).toBe("observation-unknown");
    expect(await tick(f.ports, binding, "r2")).toBe("observation-unknown");
    expect(f.calls.off).toBe(0);
    expect(f.stored()!.value.phase).toBe("watching");
    expect(f.stored()!.value.incident).toBeNull();
    expect(f.messages.size).toBe(0);
    expect(f.alerts.length).toBe(2);
    expect(new Set(f.alertKeys).size).toBe(1);
    f.patch({ ...original, crashLoop: true });
    expect(await tick(f.ports, binding, "r3")).toBe("manual");
    expect(f.calls.off).toBe(1);
  });
  test("health read outage alerts, does not infer a healthy/empty ledger", async () => {
    const f = fixture();
    const read = f.ports.read;
    f.ports.read = async () => {
      throw Error("unavailable");
    };
    expect(await tick(f.ports, binding, "r")).toBe("observation-unknown");
    expect(f.calls.off).toBe(0);
    f.ports.read = read;
    f.patch({ stopped: true });
    expect(await tick(f.ports, binding, "recovered")).toBe("manual");
    expect(f.calls.off).toBe(1);
  });
  test("CAS race permits only one OFF claimant", async () => {
    const f = fixture();
    await tick(f.ports, binding, "initialize-healthy");
    f.patch({ stopped: true });
    await Promise.all([tick(f.ports, binding, "a"), tick(f.ports, binding, "b")]);
    expect(f.calls.off).toBe(1);
  });
  test("changed health after action claim holds without OFF", async () => {
    const f = fixture();
    f.patch({ stopped: true });
    const read = f.ports.read;
    f.ports.read = async () => {
      const value = await read();
      if (f.calls.read > 1) value.revision = "newer";
      return value;
    };
    expect(await tick(f.ports, binding, "a")).toBe("held");
    expect(f.calls.off).toBe(0);
    const reads = f.calls.read;
    expect(await tick(f.ports, binding, "b")).toBe("held");
    expect(await tick(f.ports, binding, "c")).toBe("held");
    expect(f.calls.read).toBe(reads);
    expect(f.alerts.length).toBe(2);
    expect(f.messages.size).toBe(1);
  });
  test("observation age alone rejects otherwise healthy consistent timestamps", async () => {
    const f = fixture();
    f.patch({ observedAt: f.ports.now() - 120_001, lastHealthyAt: f.ports.now() - 120_001 });
    expect(await tick(f.ports, binding, "a")).toBe("observation-unknown");
    expect(f.calls.off).toBe(0);
  });
  test.each([99_999, 1_999_500])(
    "completed health must lie within activation/observation bounds: %d",
    async (lastHealthyAt) => {
      const f = fixture();
      f.patch({ observedAt: 1_999_000, lastHealthyAt, stopped: true });
      expect(await tick(f.ports, binding, "a")).toBe("observation-unknown");
      expect(f.calls.off).toBe(0);
    },
  );
  test.each([
    { phase: "off-intent", incident: null },
    { phase: "off-intent", incident: { id: "incident", runId: "" } },
    { phase: "manual", receipt: "" },
    { phase: "manual", receipt: 123 },
  ])("malformed action/manual records cannot authorize effects: %j", async (patch) => {
    const f = fixture();
    await tick(f.ports, binding, "initialize");
    const stored = structuredClone(f.stored()!);
    f.ports.load = async () =>
      ({ ...stored, value: { ...stored.value, ...patch } }) as unknown as Stored;
    const cas = f.calls.cas;
    expect(await tick(f.ports, binding, "a")).toBe("binding-hold");
    expect(f.calls.off).toBe(0);
    expect(f.calls.reconcile).toBe(0);
    expect(f.calls.cas).toBe(cas);
    expect(f.messages.size).toBe(0);
  });
  test("post-claim trigger change holds even when revision is unchanged", async () => {
    const f = fixture();
    f.patch({ stopped: true });
    const read = f.ports.read;
    f.ports.read = async () => {
      const value = await read();
      if (f.calls.read > 1) value.stopped = false;
      return value;
    };
    expect(await tick(f.ports, binding, "a")).toBe("held");
    expect(f.calls.off).toBe(0);
  });
  test("empty OFF receipt preserves intent; later ticks never replay it", async () => {
    const f = fixture();
    f.patch({ stopped: true });
    f.ports.off = async () => {
      f.calls.off++;
      return "";
    };
    await expect(tick(f.ports, binding, "a")).rejects.toThrow("no retained receipt");
    expect(f.stored()!.value.phase).toBe("off-intent");
    expect(await tick(f.ports, binding, "b")).toBe("held");
    expect(await tick(f.ports, binding, "c")).toBe("held");
    expect(f.calls.off).toBe(1);
    expect(f.calls.reconcile).toBe(1);
  });
  test("ambiguous OFF restart only reconciles terminal execution; never retries", async () => {
    const f = fixture();
    f.patch({ stopped: true });
    f.ports.off = async () => {
      f.calls.off++;
      throw Error("response lost");
    };
    expect(await tick(f.ports, binding, "a")).toBe("off-intent");
    f.execution("running");
    expect(await tick(f.ports, binding, "b")).toBe("off-in-progress");
    f.execution("unknown");
    expect(await tick(f.ports, binding, "c")).toBe("off-intent");
    expect(f.calls.reconcile).toBe(0);
    f.execution("terminal");
    f.reconciled("readback-verified-receipt");
    expect(await tick(f.ports, binding, "d")).toBe("manual");
    expect(f.calls.off).toBe(1);
    expect(f.calls.reconcile).toBe(1);
  });
  test("unknown terminal effect remains held, not replayed", async () => {
    const f = fixture();
    f.patch({ stopped: true });
    f.ports.off = async () => {
      f.calls.off++;
      throw Error("unknown");
    };
    await tick(f.ports, binding, "a");
    expect(await tick(f.ports, binding, "b")).toBe("held");
    expect(f.calls.off).toBe(1);
  });
  test("notification loss preserves intent for idempotent marker reconciliation", async () => {
    const f = fixture();
    f.patch({ stopped: true });
    const notify = f.ports.notify;
    f.ports.notify = async (...args) => {
      await notify(...args);
      throw Error("post response lost");
    };
    await expect(tick(f.ports, binding, "a")).rejects.toThrow("post response lost");
    expect(f.stored()!.value.notification).toBe("intent");
    f.ports.notify = notify;
    expect(await tick(f.ports, binding, "b")).toBe("manual");
    expect(f.calls.off).toBe(1);
    expect(f.messages.size).toBe(1);
  });
  test("lost persistence after effect is reconciled, not repeated", async () => {
    const f = fixture();
    f.patch({ stopped: true });
    const cas = f.ports.cas;
    f.ports.cas = async (version, value) => (value.phase === "manual" ? null : cas(version, value));
    expect(await tick(f.ports, binding, "a")).toBe("cas-lost");
    f.ports.cas = cas;
    f.reconciled("recovered-receipt");
    expect(await tick(f.ports, binding, "b")).toBe("manual");
    expect(f.calls.off).toBe(1);
  });
  test("old verified Manual receipt does not hide new policy drift", async () => {
    const f = fixture();
    f.patch({ stopped: true });
    await tick(f.ports, binding, "a");
    f.patch({ policy: "drift" });
    expect(await tick(f.ports, binding, "b")).toBe("manual-readback-drift");
    expect(f.calls.off).toBe(1);
    expect(f.alerts.length).toBe(1);
  });
  test("lost notification with absent marker never POSTs again", async () => {
    const f = fixture();
    f.patch({ stopped: true });
    f.ports.notify = async () => {
      throw Error("unknown notification");
    };
    await expect(tick(f.ports, binding, "a")).rejects.toThrow();
    let firstCalls = 0;
    f.ports.notify = async (_id, _reason, _receipt, mode) => {
      if (mode === "first") firstCalls++;
      return false;
    };
    expect(await tick(f.ports, binding, "b")).toBe("notification-unknown");
    expect(firstCalls).toBe(0);
    expect(f.calls.off).toBe(1);
  });
  test("prepared provider jobs are same-image separate identities with no task retry", () => {
    expect(deployment.status).toContain("not-deployable");
    const worker = deployment.watchdogJob.template.template;
    expect(worker.containers[0]!.image).toBe("${SAME_REVIEWED_BATCHER_IMAGE_DIGEST}");
    expect(worker.maxRetries).toBe(0);
    expect(deployment.watchdogSchedule.schedule).toBe("*/5 * * * *");
    expect(deployment.watchdogSchedule.retryConfig.retryCount).toBe(0);
    expect(deployment.watchdogSchedule.httpTarget.uri).toEndWith("/batcher-watchdog:run");
    expect(deployment.independentObserver.missingCompletionThresholdSeconds).toBe(1200);
  });
  test("new activation cannot reuse old watchdog state", async () => {
    const f = fixture();
    await tick(f.ports, binding, "a");
    expect(await tick(f.ports, { ...binding, activation: "new" }, "b")).toBe("binding-hold");
    expect(f.calls.off).toBe(0);
  });
  test("initial heartbeat failure prevents mutations; external observer sees missing completions", async () => {
    const f = fixture();
    f.patch({ stopped: true });
    f.ports.heartbeat = async () => {
      throw Error("cannot record run");
    };
    await expect(tick(f.ports, binding, "a")).rejects.toThrow();
    expect(f.calls.off).toBe(0);
    expect(missedRuns(null, 0, staleAfterMs)).toBe(false);
    expect(missedRuns(null, 0, missedCompletionAfterMs)).toBe(true);
    expect(missedRuns(100, 0, 101)).toBe(false);
    expect(missedRuns(100, 0, 100 + missedCompletionAfterMs)).toBe(true);
    expect(missedRuns(100, 0, 99)).toBe(true);
  });
});
