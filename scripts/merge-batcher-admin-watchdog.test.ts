import { describe, expect, test } from "bun:test";
import deployment from "../docs/merge-batcher-admin/watchdog-deployment.json";
import {
  classify,
  missedRuns,
  tick,
  staleAfterMs,
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
    alert: async (reason) => {
      alerts.push(reason);
    },
  };
  return {
    ports,
    calls,
    heartbeat,
    messages,
    alerts,
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
  test.each(["stopped", "crash-loop", "stale-health"] as const)(
    "%s calls OFF once and posts verified result",
    async (trigger) => {
      const f = fixture();
      f.patch(
        trigger === "stopped"
          ? { stopped: true }
          : trigger === "crash-loop"
            ? { crashLoop: true }
            : { lastHealthyAt: 100_000 },
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
    f.patch({ lastHealthyAt: null, activatedAt: f.ports.now() });
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
  ])("unknown health/identity/policy holds and alerts: %j", async (patch) => {
    const f = fixture();
    f.patch({ stopped: true, ...patch });
    expect(await tick(f.ports, binding, "r1")).toBe("held");
    expect(await tick(f.ports, binding, "r2")).toBe("held");
    expect(f.calls.off).toBe(0);
    expect(f.messages.size).toBe(1);
  });
  test("health read outage alerts, does not infer a healthy/empty ledger", async () => {
    const f = fixture();
    f.ports.read = async () => {
      throw Error("unavailable");
    };
    expect(await tick(f.ports, binding, "r")).toBe("held");
    expect(f.calls.off).toBe(0);
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
    const observer = deployment.observerJob.template.template;
    expect(worker.containers[0]!.image).toBe(observer.containers[0]!.image);
    expect(worker.serviceAccount).not.toBe(observer.serviceAccount);
    expect(worker.maxRetries).toBe(0);
    expect(observer.maxRetries).toBe(0);
    expect(deployment.watchdogSchedule.schedule).toBe("*/5 * * * *");
    expect(deployment.watchdogSchedule.retryConfig.retryCount).toBe(0);
    expect(deployment.watchdogSchedule.httpTarget.uri).toEndWith("/batcher-watchdog:run");
    expect(deployment.observerSchedule.httpTarget.uri).toEndWith("/batcher-watchdog-observer:run");
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
    expect(missedRuns(null, 0, staleAfterMs)).toBe(true);
    expect(missedRuns(100, 0, 101)).toBe(false);
    expect(missedRuns(100, 0, 100 + staleAfterMs)).toBe(true);
    expect(missedRuns(100, 0, 99)).toBe(true);
  });
});
