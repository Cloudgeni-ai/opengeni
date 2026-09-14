import { describe, expect, spyOn, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import type { TurnHeartbeatDetails } from "../src/op-journal";
import { startTurnFinalizationMonitor } from "../src/activities/agent-turn/finalization-monitor";

function sample(metrics: string, name: string, stage: string): number {
  const line = metrics
    .split("\n")
    .find((entry) => entry.startsWith(`${name}{`) && entry.includes(`stage="${stage}"`));
  return Number(line?.split(" ").at(-1));
}

function observability() {
  return createObservability(
    {
      serviceName: "opengeni",
      environment: "test",
      deploymentRevision: "test",
      observabilityStructuredLogs: true,
      observabilityMetricsEnabled: true,
      observabilityOtlpEndpoint: undefined,
      observabilityOtlpHeaders: undefined,
    },
    { component: "worker-turn" },
  );
}

describe("turn finalization diagnostics", () => {
  test("counts concurrent cleanup stages and preserves exact heartbeat acknowledgements", async () => {
    const obs = observability();
    const details: TurnHeartbeatDetails = {
      sessionId: "private-session",
      opAcks: { exact_op: "17" },
    };
    const heartbeats: unknown[] = [];
    const first = startTurnFinalizationMonitor({
      observability: obs,
      details,
      heartbeat: (x) => heartbeats.push(structuredClone(x)),
      terminateWorker() {},
    });
    const second = startTurnFinalizationMonitor({
      observability: obs,
      details: { opAcks: {} },
      heartbeat() {},
      terminateWorker() {},
    });
    try {
      first.enter("tool_writers");
      second.enter("tool_writers");
      expect(
        sample(
          await obs.prometheusMetrics(),
          "opengeni_turn_finalization_inflight",
          "tool_writers",
        ),
      ).toBe(2);
      first.enter("workspace_snapshot");
      const metrics = await obs.prometheusMetrics();
      expect(sample(metrics, "opengeni_turn_finalization_inflight", "tool_writers")).toBe(1);
      expect(sample(metrics, "opengeni_turn_finalization_inflight", "workspace_snapshot")).toBe(1);
      expect(metrics).not.toContain("private-session");
      expect(heartbeats.at(-1)).toMatchObject({
        phase: "finalizing",
        finalizationStage: "workspace_snapshot",
        opAcks: { exact_op: "17" },
      });
    } finally {
      first.stop();
      second.stop();
      first.stop();
    }
    expect(
      sample(
        await obs.prometheusMetrics(),
        "opengeni_turn_finalization_inflight",
        "workspace_snapshot",
      ),
    ).toBe(0);
    expect(
      sample(await obs.prometheusMetrics(), "opengeni_turn_finalization_inflight", "tool_writers"),
    ).toBe(0);
  });

  test("retains a readable bounded cause through the real public telemetry filter", async () => {
    const logs: string[] = [];
    const output = spyOn(console, "error").mockImplementation((...args) =>
      logs.push(args.join(" ")),
    );
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const obs = observability();
    let exits = 0;
    const monitor = startTurnFinalizationMonitor({
      observability: obs,
      details: { opAcks: {} },
      heartbeat() {},
      timeoutMs: 10,
      slowAfterMs: 1,
      terminateWorker() {
        exits++;
      },
    });
    try {
      monitor.enter("credential_cleanup");
      await Bun.sleep(15);
      expect(exits).toBe(1);
      expect(logs.join("\n")).toContain('"reason":"credential_cleanup"');
      expect(logs.join("\n")).toContain('"surface":"turn_finalization"');
      expect(
        sample(
          await obs.prometheusMetrics(),
          "opengeni_turn_finalization_slow_total",
          "credential_cleanup",
        ),
      ).toBe(1);
    } finally {
      monitor.stop();
      output.mockRestore();
      warning.mockRestore();
    }
  });
});
