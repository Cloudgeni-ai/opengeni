// The metrics adapter for the Connected Machine op-observer: maps a runtime
// `SelfhostedOpObservation` onto the `onSandboxOp` metrics hook (bounded labels:
// the wire ErrorCode → its stable enum-name string; duration → seconds).

import { describe, expect, test } from "bun:test";
import { ErrorCode } from "@opengeni/agent-proto";
import type { RuntimeMetricsHooks } from "@opengeni/runtime";
import { selfhostedOpObserverForMetrics } from "../src/observability-metrics";

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
