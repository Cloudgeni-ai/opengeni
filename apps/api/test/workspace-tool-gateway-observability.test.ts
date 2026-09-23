import { describe, expect, test } from "bun:test";
import type { Observability } from "@opengeni/observability";
import { startWorkspaceToolGatewayObservation } from "../src/workspace-tool-gateway-observability";

describe("workspace tool gateway observability", () => {
  test("emits one bounded metric, duration, span, and safe log projection", () => {
    const calls: Array<{ kind: string; value: unknown }> = [];
    const observability = {
      startSpan: (name: string, attributes: unknown) => {
        calls.push({ kind: "span.start", value: { name, attributes } });
        return {
          traceId: "trace",
          spanId: "span",
          end: (value: unknown) => calls.push({ kind: "span.end", value }),
        };
      },
      incrementCounter: (value: unknown) => calls.push({ kind: "counter", value }),
      observeHistogram: (value: unknown) => calls.push({ kind: "histogram", value }),
      info: (message: string, attributes: unknown) =>
        calls.push({ kind: "log", value: { message, attributes } }),
    } as unknown as Observability;
    const observation = startWorkspaceToolGatewayObservation(observability, {
      adapter: "http",
      operation: "call",
      source: "docs",
    });

    observation.end("approval_required");
    observation.end("failed");

    expect(calls.map((call) => call.kind)).toEqual([
      "span.start",
      "counter",
      "histogram",
      "log",
      "span.end",
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/workspaceId|subjectId|toolName|arguments|token/u);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "counter",
          value: expect.objectContaining({
            labels: {
              adapter: "http",
              operation: "call",
              source: "docs",
              outcome: "approval_required",
            },
          }),
        }),
      ]),
    );
  });

  test("isolates observer failures from product execution", () => {
    const observability = {
      startSpan: () => {
        throw new Error("span unavailable");
      },
      incrementCounter: () => {
        throw new Error("metrics unavailable");
      },
    } as unknown as Observability;

    const observation = startWorkspaceToolGatewayObservation(observability, {
      adapter: "mcp",
      operation: "call",
      source: "mcp",
    });
    expect(() => observation.end("failed")).not.toThrow();
  });
});
