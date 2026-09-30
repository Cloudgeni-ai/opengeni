import { expect, test } from "bun:test";
import {
  beginMcpPhase,
  bindMcpTelemetry,
  createObservability,
  currentTraceContext,
  measureMcpPhase,
  withMcpCallIdentity,
  withMcpTelemetry,
  withTraceContext,
} from "../src";

function fixture() {
  const bodies: any[] = [];
  const observer = createObservability(
    {
      serviceName: "test",
      environment: "test",
      observabilityStructuredLogs: true,
      observabilityMetricsEnabled: true,
      observabilityOtlpHeaders: "",
      observabilityOtlpEndpoint: "http://collector",
    },
    {
      component: "worker",
      exporter: async (_url, body) => {
        bodies.push(body);
      },
    },
  );
  return {
    observer,
    spans: () => bodies.flatMap((b) => b.resourceSpans.flatMap((r: any) => r.scopeSpans[0].spans)),
  };
}
const attrs = (span: any) =>
  Object.fromEntries(span.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));

test("MCP timing retains opaque call and attempt identity across delayed callbacks without cross-call inheritance", async () => {
  const { observer, spans } = fixture();
  const root = observer.startSpan("root");
  let callback!: () => Promise<void>;
  await withMcpTelemetry(observer, "attempt-secret", () =>
    withTraceContext(root, async () => {
      await Promise.all(
        ["call-secret-a", "call-secret-b"].map((id) =>
          withMcpCallIdentity(id, async () => {
            await measureMcpPhase("gateway_policy", async () => {
              await measureMcpPhase("provider_authorization", async () => true);
            });
            const execute = bindMcpTelemetry(async () => {
              await measureMcpPhase("execution", async () => {
                await measureMcpPhase("network_headers", async () => undefined);
                await measureMcpPhase("network_headers", async () => undefined);
              });
            });
            if (id.endsWith("a")) callback = execute;
            else await execute();
          }),
        ),
      );
    }),
  );
  expect(currentTraceContext()).toBeUndefined();
  await callback();
  root.end();
  await observer.flush();
  const policy = spans().filter((s) => s.name === "mcp.phase.gateway_policy");
  const execution = spans().filter((s) => s.name === "mcp.phase.execution");
  expect(new Set(policy.map((s) => attrs(s).mcpCallKey)).size).toBe(2);
  for (const span of execution) {
    expect(span.parentSpanId).toBe(root.spanId);
    expect(span.traceId).toBe(root.traceId);
    const key = attrs(span).mcpCallKey;
    expect(key).toMatch(/^mcp_[0-9a-f]{32}$/);
    expect(policy.some((s) => attrs(s).mcpCallKey === key)).toBe(true);
    expect(
      spans()
        .filter((s) => s.name === "mcp.phase.network_headers" && attrs(s).mcpCallKey === key)
        .map((s) => attrs(s).attempt),
    ).toEqual([1, 2]);
  }
  expect(JSON.stringify(spans())).not.toContain("secret");
  expect(currentTraceContext()).toBeUndefined();
});

test("MCP phase failures and rejections are exported without sensitive exceptions, with monotonic durations", async () => {
  const { observer, spans } = fixture();
  const error = new Error("SECRET_ERROR_ARGUMENT_RESULT");
  await withMcpTelemetry(observer, "scope", () =>
    withMcpCallIdentity("call", async () => {
      await expect(
        measureMcpPhase("execution", () => {
          throw error;
        }),
      ).rejects.toBe(error);
      expect(
        await measureMcpPhase(
          "provider_authorization",
          () => false,
          () => "rejected",
        ),
      ).toBe(false);
      const body = beginMcpPhase("network_body");
      body.end("cancelled");
      body.end();
    }),
  );
  await observer.flush();
  expect(spans()).toHaveLength(3);
  expect(spans().map((s) => attrs(s).outcome)).toEqual(["failed", "rejected", "cancelled"]);
  for (const span of spans()) {
    expect(attrs(span)["opengeni.duration_ms"]).toBeGreaterThanOrEqual(0);
    expect(span.status.code).toBe(2);
  }
  expect(JSON.stringify(spans())).not.toContain("SECRET");
});

test("MCP observer and classifier failures never affect execution, result identity or thrown identity", async () => {
  const { observer } = fixture();
  observer.startSpan = () => {
    throw new Error("observer unavailable");
  };
  observer.observeHistogram = () => {
    throw new Error("metrics unavailable");
  };
  const value = { untouched: true };
  const error = new Error("execution failed");
  let calls = 0;
  await withMcpTelemetry(observer, "scope", async () => {
    expect(() =>
      withMcpCallIdentity(undefined as unknown as string, () => {
        throw error;
      }),
    ).toThrow(error);
    expect(
      await measureMcpPhase(
        "execution",
        () => {
          calls++;
          return value;
        },
        () => {
          throw error;
        },
      ),
    ).toBe(value);
    await expect(
      measureMcpPhase("execution", () => {
        calls++;
        throw error;
      }),
    ).rejects.toBe(error);
  });
  expect(calls).toBe(2);
});

test("MCP call keys are stable only within the exact host scope and never metric labels", async () => {
  const { observer, spans } = fixture();
  for (const scope of ["attempt-one", "attempt-one", "attempt-two"]) {
    await withMcpTelemetry(observer, scope, () =>
      withMcpCallIdentity("same-call", () => measureMcpPhase("execution", () => true)),
    );
  }
  await observer.flush();
  const keys = spans().map((s) => attrs(s).mcpCallKey);
  expect(keys[0]).toBe(keys[1]);
  expect(keys[0]).not.toBe(keys[2]);
  const metrics = await observer.prometheusMetrics();
  expect(metrics).not.toContain(keys[0]);
  expect(metrics).not.toContain("attempt-one");
});
