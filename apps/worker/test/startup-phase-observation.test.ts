import { expect, test } from "bun:test";
import { createObservability, type Observability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { measureTurnStartupPhase } from "../src/observability-metrics";

test("a held dependency emits no completion before it settles", async () => {
  const o = createObservability(testSettings(), { component: "worker" });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const value = {};
  const running = measureTurnStartupPhase(
    o,
    {
      phase: "claim_session_read",
      provider: "unresolved",
      backend: "none",
    },
    async () => {
      await held;
      return value;
    },
  );
  try {
    expect(await o.prometheusMetrics()).not.toContain('phase="claim_session_read"');
  } finally {
    release();
  }
  expect(await running).toBe(value);
  const metrics = await o.prometheusMetrics();
  expect(metrics).toMatch(
    /opengeni_turn_startup_phase_duration_seconds_count\{[^}]*backend="none"[^}]*outcome="completed"[^}]*phase="claim_session_read"[^}]*provider="unresolved"[^}]*\} 1\b/,
  );
});

test("failed sync and async dependencies emit bounded failure outcomes", async () => {
  const o = createObservability(testSettings(), { component: "worker" });
  const failure = new Error("private dependency detail");
  for (const work of [
    () => {
      throw failure;
    },
    async () => {
      throw failure;
    },
  ]) {
    await expect(
      measureTurnStartupPhase(
        o,
        {
          phase: "claim_atomic",
          provider: "unresolved",
          backend: "unresolved",
        },
        work,
      ),
    ).rejects.toBe(failure);
  }
  const metrics = await o.prometheusMetrics();
  expect(metrics).toMatch(
    /opengeni_turn_startup_phase_duration_seconds_count\{[^}]*outcome="failed"[^}]*phase="claim_atomic"[^}]*\} 2\b/,
  );
  expect(metrics).not.toContain("private dependency");
  expect(metrics).not.toContain("sessionId");
});

test("observer failures do not change dependency values or errors", async () => {
  const failure = new Error("original");
  const value = {};
  for (const broken of ["startSpan", "observeHistogram"] as const) {
    const o = {
      startSpan: () => {
        if (broken === "startSpan") throw new Error("span exporter");
        return { end() {} };
      },
      observeHistogram: () => {
        throw new Error("metric exporter");
      },
    } as unknown as Observability;
    const input = {
      phase: "claim_capability_settings" as const,
      provider: "unresolved",
      backend: "none",
    };
    expect(await measureTurnStartupPhase(o, input, async () => value)).toBe(value);
    await expect(
      measureTurnStartupPhase(o, input, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  }
});
