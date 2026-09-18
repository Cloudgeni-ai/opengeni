import { expect, test } from "bun:test";
import { createObservability, withTraceContext, parseTraceparent, traceparent } from "../src";

test("interleaved async operations export exact parent identity without cross-request inheritance", async () => {
  const bodies: any[] = [];
  const obs = createObservability(
    {
      serviceName: "test",
      environment: "test",
      observabilityStructuredLogs: true,
      observabilityMetricsEnabled: false,
      observabilityOtlpHeaders: "",
      observabilityOtlpEndpoint: "http://collector",
    },
    {
      component: "api",
      exporter: async (_url, body) => {
        bodies.push(body);
      },
    },
  );
  const a = obs.startSpan("a");
  const b = obs.startSpan("b");
  const children = await Promise.all(
    [a, b].map((parent, index) =>
      withTraceContext(parent, async () => {
        await Bun.sleep(index);
        const child = obs.startSpan("child", { prompt: "SECRET_CANARY" });
        await withTraceContext(child, async () => {
          await Bun.sleep(0);
          obs.startSpan("grandchild").end();
        });
        child.end();
        return child;
      }),
    ),
  );
  a.end();
  b.end();
  await obs.flush();
  const spans = bodies.flatMap((body) =>
    body.resourceSpans.flatMap((resource: any) => resource.scopeSpans[0].spans),
  );
  expect(a.traceId).not.toBe(b.traceId);
  for (const [i, parent] of [a, b].entries()) {
    expect(children[i]!.traceId).toBe(parent.traceId);
    expect(spans.find((s) => s.spanId === children[i]!.spanId).parentSpanId).toBe(parent.spanId);
    expect(
      spans.find((s) => s.traceId === parent.traceId && s.name === "grandchild").parentSpanId,
    ).toBe(children[i]!.spanId);
  }
  expect(JSON.stringify(bodies)).not.toContain("SECRET_CANARY");
  expect(obs.startSpan("outside").traceId).not.toBe(a.traceId);
  expect(parseTraceparent(traceparent(a))).toEqual({ traceId: a.traceId, spanId: a.spanId });
  expect(parseTraceparent("00-" + "0".repeat(32) + "-" + a.spanId + "-01")).toBeUndefined();
});

test("structured log identity comes only from scoped context, never caller attributes", () => {
  const obs = createObservability(
    {
      serviceName: "test",
      environment: "test",
      observabilityStructuredLogs: true,
      observabilityMetricsEnabled: false,
      observabilityOtlpHeaders: "",
    },
    { component: "api" },
  );
  const original = console.log;
  const logs: string[] = [];
  console.log = (value) => {
    logs.push(String(value));
  };
  try {
    const span = obs.startSpan("request");
    withTraceContext(span, () =>
      obs.info("fixed", { traceId: "SECRET_CANARY", spanId: "SECRET_CANARY" }),
    );
    obs.info("outside", { traceId: "SECRET_CANARY" });
    expect(JSON.parse(logs[0]!)).toMatchObject({ traceId: span.traceId, spanId: span.spanId });
    expect(JSON.parse(logs[1]!)).not.toHaveProperty("traceId");
    expect(logs.join("")).not.toContain("SECRET_CANARY");
  } finally {
    console.log = original;
  }
});
