import { expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import {
  MCP_LIFECYCLE_OUTCOMES,
  MCP_LIFECYCLE_PHASES,
  MCP_LIFECYCLE_POLICIES,
  MCP_TOOL_CALL_OUTCOMES,
} from "@opengeni/runtime";
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

test("MCP lifecycle metrics expose only bounded structural dimensions", async () => {
  const observability = createObservability(testSettings(), { component: "worker" });
  const hooks = runtimeMetricsHooksForObservability(observability);

  let durationSeconds = 0.25;
  for (const phase of MCP_LIFECYCLE_PHASES) {
    for (const policy of MCP_LIFECYCLE_POLICIES) {
      for (const outcome of MCP_LIFECYCLE_OUTCOMES) {
        hooks.onMcpLifecycle?.({ phase, policy, outcome, durationSeconds });
        durationSeconds += 1;
      }
    }
  }

  const metrics = await observability.prometheusMetrics();
  for (const phase of MCP_LIFECYCLE_PHASES) {
    for (const policy of MCP_LIFECYCLE_POLICIES) {
      for (const outcome of MCP_LIFECYCLE_OUTCOMES) {
        const labels = `[^}]*outcome="${outcome}"[^}]*phase="${phase}"[^}]*policy="${policy}"[^}]*`;
        expect(metrics).toMatch(
          new RegExp(`opengeni_mcp_lifecycle_operations_total\\{${labels}\\} 1\\b`),
        );
        expect(metrics).toMatch(
          new RegExp(`opengeni_mcp_lifecycle_operation_duration_seconds_count\\{${labels}\\} 1\\b`),
        );
      }
    }
  }
  expect(metrics).not.toMatch(/server(_id)?=|tool(_name)?=|workspace(_id)?=|session(_id)?=/);
});
