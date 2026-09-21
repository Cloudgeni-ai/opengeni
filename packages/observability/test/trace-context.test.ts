import { expect, test } from "bun:test";
import { createObservability, withTraceContext, parseTraceparent, traceparent } from "../src";
import { validTraceContext } from "../src/trace-context";

test("trace identities reject accessors, prototypes, coercion and hostile descriptor traps", async () => {
  const traceId = "a".repeat(32);
  const spanId = "b".repeat(16);
  let unsafeCalls = 0;
  const unsafe = () => {
    unsafeCalls++;
    return "SECRET_GETTER";
  };
  const inputs = [
    {
      get traceId() {
        return unsafe();
      },
      spanId,
    },
    {
      traceId,
      get spanId() {
        return unsafe();
      },
    },
    Object.create({ traceId, spanId }),
    {
      traceId: {
        toString: () => {
          unsafeCalls++;
          return traceId;
        },
        toJSON: unsafe,
      },
      spanId,
    },
    { traceId, spanId: new String(spanId) },
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("SECRET_TRAP");
        },
      },
    ),
    { traceId: "0".repeat(32), spanId },
  ];
  const bodies: unknown[] = [];
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
  for (const input of inputs) {
    expect(validTraceContext(input)).toBeUndefined();
    const span = obs.startSpan("hostile", {}, { parent: input, links: [input] });
    span.addLink?.(input);
    expect(span.traceId).not.toBe(traceId);
    withTraceContext(input, () => expect(obs.startSpan("isolated").traceId).not.toBe(traceId));
    span.end();
  }
  const valid = { traceId, spanId, toJSON: unsafe };
  const snapshot = validTraceContext(valid);
  valid.traceId = "SECRET_MUTATION";
  expect(snapshot).toEqual({ traceId, spanId });
  withTraceContext(
    {
      traceId,
      spanId,
      get addLink() {
        unsafe();
        return undefined;
      },
    },
    () => {
      expect(obs.startSpan("safe-scope").traceId).toBe(traceId);
    },
  );
  const safe = obs.startSpan("safe", {}, { links: [snapshot!] });
  safe.addLink?.({ traceId, spanId });
  safe.end();
  await obs.flush();
  expect(unsafeCalls).toBe(0);
  expect(JSON.stringify(bodies)).not.toContain("SECRET");
  const spans = (bodies as any[]).flatMap((body) =>
    body.resourceSpans.flatMap((r: any) => r.scopeSpans[0].spans),
  );
  expect(
    spans.filter((s) => s.name === "hostile").every((s) => !s.parentSpanId && s.links.length === 0),
  ).toBe(true);
  expect(spans.find((s) => s.name === "safe").links).toEqual([{ traceId, spanId }]);
});

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
