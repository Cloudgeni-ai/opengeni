import { expect, test } from "bun:test";
import { createObservability, withTraceContext } from "@opengeni/observability";
import {
  MCP_LIFECYCLE_OUTCOMES,
  MCP_LIFECYCLE_PHASES,
  MCP_LIFECYCLE_POLICIES,
  MCP_TOOL_CALL_OUTCOMES,
} from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import { runtimeMetricsHooksForObservability } from "../src/observability-metrics";

test("every model and MCP call exports measured spans under the physical attempt", async () => {
  const bodies: any[] = [];
  const observability = createObservability(
    { ...testSettings(), observabilityOtlpEndpoint: "http://collector" },
    {
      component: "worker",
      exporter: async (_url, body) => {
        bodies.push(body);
      },
    },
  );
  const hooks = runtimeMetricsHooksForObservability(observability);
  const parent = observability.startSpan("attempt");
  withTraceContext(parent, () => {
    for (let i = 0; i < 3; i++) {
      hooks.onModelCall?.({ provider: "openai", outcome: "completed", durationSeconds: 1 });
      hooks.onMcpToolCall?.({ outcome: "success", durationSeconds: 0.5 });
    }
  });
  await observability.flush();
  const spans = bodies.flatMap((body) =>
    body.resourceSpans.flatMap((resource: any) => resource.scopeSpans[0].spans),
  );
  expect(spans).toHaveLength(6);
  for (const span of spans) {
    expect(span.traceId).toBe(parent.traceId);
    expect(span.parentSpanId).toBe(parent.spanId);
    expect(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toBeGreaterThanOrEqual(
      500_000_000n,
    );
  }
  expect(bodies).toHaveLength(1);
});

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
