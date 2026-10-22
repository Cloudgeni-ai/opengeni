import { describe, expect, test } from "bun:test";
import {
  agentToolCallOutcome,
  agentToolMetricFamily,
  createObservability,
  recordAgentToolCall,
} from "../src/index";

describe("agent tool metrics", () => {
  test("maps tool names and analytics families onto the closed set", () => {
    expect(agentToolMetricFamily(null, "exec_command")).toBe("shell");
    expect(agentToolMetricFamily("browser_observe")).toBe("browser");
    expect(agentToolMetricFamily(null, "interaction__computer_act")).toBe("computer");
    expect(agentToolMetricFamily("interaction_request_human")).toBe("human_handoff");
    expect(agentToolMetricFamily("integration:linear.app", "mcp_abc__create_issue")).toBe(
      "integration",
    );
    expect(agentToolMetricFamily("custom", "mcp_abc__thing")).toBe("custom_mcp");
    expect(agentToolMetricFamily(null, "opengeni__goal_update")).toBe("goal");
    expect(agentToolMetricFamily(null, "some_future_tool")).toBe("other");
    expect(agentToolMetricFamily(null, null)).toBe("other");
  });

  test("classifies structural outcomes without reading content", () => {
    expect(agentToolCallOutcome({ output: { isError: true, text: "x" } })).toBe("error");
    expect(agentToolCallOutcome({ failed: true })).toBe("error");
    expect(agentToolCallOutcome({ output: "Tool execution was not approved." })).toBe("rejected");
    expect(agentToolCallOutcome({ output: "aborted" })).toBe("cancelled");
    expect(
      agentToolCallOutcome({
        output: "An error occurred while running the tool. Please try again.",
      }),
    ).toBe("error");
    expect(agentToolCallOutcome({ output: "all good" })).toBe("ok");
  });

  test("counts by family and outcome", async () => {
    const observability = createObservability(
      {
        serviceName: "opengeni",
        environment: "test",
        deploymentRevision: "revision-test",
        observabilityStructuredLogs: false,
        observabilityMetricsEnabled: true,
        observabilityOtlpEndpoint: "",
        observabilityOtlpHeaders: "",
      },
      { component: "worker-turn" },
    );
    recordAgentToolCall(observability, { family: "browser", outcome: "error", durationMs: 1500 });
    const metrics = await observability.prometheusMetrics();
    const line = metrics
      .split("\n")
      .find((candidate) => candidate.startsWith("opengeni_agent_tool_calls_total{"));
    expect(line).toContain('family="browser"');
    expect(line).toContain('outcome="error"');
    expect(metrics).toContain("opengeni_agent_tool_call_duration_seconds_bucket");
  });
});
