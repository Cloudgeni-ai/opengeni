// The metrics adapter for the Connected Machine op-observer: maps a runtime
// `SelfhostedOpObservation` onto the `onSandboxOp` metrics hook (bounded labels:
// the wire ErrorCode → its stable enum-name string; duration → seconds).

import { describe, expect, test } from "bun:test";
import { ErrorCode } from "@opengeni/agent-proto";
import type { RuntimeMetricsHooks, SelfhostedOpObservation } from "@opengeni/runtime";
import {
  machineOpSessionEventFor,
  makeMachineOpObserver,
  selfhostedOpObserverForMetrics,
} from "../src/observability-metrics";

function obs(over: Partial<SelfhostedOpObservation>): SelfhostedOpObservation {
  return { op: "exec", outcome: "ok", healed: false, retries: 0, durationMs: 1, ...over };
}

type SandboxOpInput = Parameters<NonNullable<RuntimeMetricsHooks["onSandboxOp"]>>[0];

function captureHooks(): { seen: SandboxOpInput[]; hooks: RuntimeMetricsHooks } {
  const seen: SandboxOpInput[] = [];
  return { seen, hooks: { onSandboxOp: (o) => seen.push(o) } };
}

describe("selfhostedOpObserverForMetrics", () => {
  test("a clean success maps to backend=selfhosted, outcome ok, not healed", () => {
    const { seen, hooks } = captureHooks();
    selfhostedOpObserverForMetrics(hooks)({
      op: "exec",
      outcome: "ok",
      healed: false,
      retries: 0,
      durationMs: 1200,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      backend: "selfhosted",
      op: "exec",
      outcome: "ok",
      healed: false,
      retries: 0,
      durationSeconds: 1.2,
    });
    expect(seen[0]!.code).toBeUndefined();
    expect(seen[0]!.replyBytes).toBeUndefined();
  });

  test("a healed success carries the healed flag + retry count", () => {
    const { seen, hooks } = captureHooks();
    selfhostedOpObserverForMetrics(hooks)({
      op: "exec",
      outcome: "ok",
      healed: true,
      retries: 3,
      durationMs: 5000,
    });
    expect(seen[0]).toMatchObject({ healed: true, retries: 3 });
  });

  test("a failure maps the wire code to its stable enum-name label", () => {
    const { seen, hooks } = captureHooks();
    selfhostedOpObserverForMetrics(hooks)({
      op: "exec",
      outcome: "failed",
      healed: false,
      retries: 2,
      durationMs: 800,
      code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
    });
    expect(seen[0]).toMatchObject({ outcome: "failed", code: "ERROR_CODE_AGENT_OFFLINE" });
  });

  test("a payload-wall fault forwards replyBytes", () => {
    const { seen, hooks } = captureHooks();
    selfhostedOpObserverForMetrics(hooks)({
      op: "exec",
      outcome: "failed",
      healed: false,
      retries: 0,
      durationMs: 50,
      code: ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE,
      replyBytes: 1_500_000,
    });
    expect(seen[0]).toMatchObject({
      code: "ERROR_CODE_PAYLOAD_TOO_LARGE",
      replyBytes: 1_500_000,
    });
  });

  test("no onSandboxOp hook wired is a clean no-op (never throws)", () => {
    expect(() =>
      selfhostedOpObserverForMetrics({})({
        op: "ping",
        outcome: "ok",
        healed: false,
        retries: 0,
        durationMs: 1,
      }),
    ).not.toThrow();
  });
});

describe("machineOpSessionEventFor — only infra failures + healed recoveries are eventable", () => {
  test("an infra failure maps to machine.op.failed", () => {
    const event = machineOpSessionEventFor(
      obs({ outcome: "failed", faultClass: "offline", retries: 3, machineId: "m1" }),
    );
    expect(event).toEqual({
      type: "machine.op.failed",
      payload: { op: "exec", faultClass: "offline", attempts: 3, machineId: "m1" },
    });
  });

  test("a semantic-miss failure does NOT fire machine.op.failed", () => {
    for (const faultClass of ["not_found", "consent", "fenced"]) {
      expect(machineOpSessionEventFor(obs({ outcome: "failed", faultClass }))).toBeNull();
    }
  });

  test("a healed op maps to machine.op.recovered", () => {
    const event = machineOpSessionEventFor(
      obs({ outcome: "ok", healed: true, faultClass: "draining", retries: 2, machineId: "m1" }),
    );
    expect(event).toEqual({
      type: "machine.op.recovered",
      payload: { op: "exec", faultClass: "draining", attempts: 2, machineId: "m1" },
    });
  });

  test("a clean success is not eventable", () => {
    expect(machineOpSessionEventFor(obs({ outcome: "ok", healed: false }))).toBeNull();
  });
});

describe("makeMachineOpObserver — meters all ops, buffers only eventable ones", () => {
  test("meters every op but buffers only infra-failure + healed events; drain clears", () => {
    const seen: unknown[] = [];
    const { observer, drainEvents } = makeMachineOpObserver({ onSandboxOp: (o) => seen.push(o) });
    observer(obs({ outcome: "ok", healed: false })); // metered, not eventable
    observer(obs({ outcome: "ok", healed: true, faultClass: "reconnecting", retries: 1 })); // recovered
    observer(obs({ outcome: "failed", faultClass: "payload_too_large", retries: 0 })); // failed
    observer(obs({ outcome: "failed", faultClass: "consent" })); // semantic — metered, not eventable

    expect(seen).toHaveLength(4); // every op metered
    const events = drainEvents();
    expect(events.map((e) => e.type)).toEqual(["machine.op.recovered", "machine.op.failed"]);
    expect(drainEvents()).toHaveLength(0); // drain cleared the buffer
  });
});
