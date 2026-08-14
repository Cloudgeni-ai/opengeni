import { expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { MCP_TOOL_CALL_OUTCOMES } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import { runtimeMetricsHooksForObservability } from "../src/observability-metrics";

test("MCP tool-call metrics expose only the closed structural outcome", async () => {
  const observability = createObservability(testSettings(), { component: "worker" });
  const hooks = runtimeMetricsHooksForObservability(observability);

  MCP_TOOL_CALL_OUTCOMES.forEach((outcome, index) => {
    hooks.onMcpToolCall?.({ outcome, durationSeconds: index + 0.25 });
  });

  const metrics = await observability.prometheusMetrics();
  for (const outcome of MCP_TOOL_CALL_OUTCOMES) {
    expect(metrics).toMatch(
      new RegExp(`opengeni_mcp_tool_calls_total\\{[^}]*outcome="${outcome}"[^}]*\\} 1\\b`),
    );
    expect(metrics).toMatch(
      new RegExp(
        `opengeni_mcp_tool_call_duration_seconds_count\\{[^}]*outcome="${outcome}"[^}]*\\} 1\\b`,
      ),
    );
  }
  expect(metrics).not.toMatch(/server(_id)?=|tool(_name)?=|workspace(_id)?=|session(_id)?=/);
});
