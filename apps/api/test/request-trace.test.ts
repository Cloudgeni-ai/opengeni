import { describe, expect, test } from "bun:test";
import { createObservability, traceClientCalls, traceFetch } from "@opengeni/observability";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import { requestSpanTraceParent } from "../src/http/request-trace";

const CALLER = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: "01",
};
const HEADER = `00-${CALLER.traceId}-${CALLER.spanId}-01`;

type ExportedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  links: Array<{ traceId: string; spanId: string }>;
  name: string;
  kind: number;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
};

function harness(trustIncoming: boolean) {
  const bodies: unknown[] = [];
  const observability = createObservability(
    {
      serviceName: "opengeni",
      environment: "test",
      observabilityStructuredLogs: false,
      observabilityMetricsEnabled: false,
      observabilityOtlpEndpoint: "http://collector",
      observabilityOtlpHeaders: "",
    },
    {
      component: "api",
      exporter: async (_url, body) => {
        bodies.push(body);
      },
    },
  );
  const app = createApp({
    settings: testSettings({ observabilityTrustIncomingTraceContext: trustIncoming }),
    db: {} as never,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    managedAuth: null,
    observability,
  });
  const spans = async (): Promise<ExportedSpan[]> => {
    await observability.flush();
    return bodies.flatMap((body) =>
      (
        body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: ExportedSpan[] }> }> }
      ).resourceSpans.flatMap((resource) => resource.scopeSpans[0]!.spans),
    );
  };
  return { app, spans, bodies };
}

const serverSpan = (spans: ExportedSpan[]) => spans.find((span) => span.kind === 2)!;

describe("incoming W3C trace context", () => {
  test("a valid header is a link by default and the parent only when trusted", () => {
    expect(requestSpanTraceParent(HEADER, false)).toEqual({ parent: null, links: [CALLER] });
    expect(requestSpanTraceParent(HEADER, true)).toEqual({ parent: CALLER, links: [] });
    for (const invalid of [
      undefined,
      "",
      `00-${CALLER.traceId}-${CALLER.spanId}`,
      `00-${CALLER.traceId.toUpperCase()}-${CALLER.spanId}-01`,
      `00-${"0".repeat(32)}-${CALLER.spanId}-01`,
      `${HEADER}, ${HEADER}`,
    ]) {
      expect(requestSpanTraceParent(invalid, true)).toEqual({ parent: null, links: [] });
      expect(requestSpanTraceParent(invalid, false)).toEqual({ parent: null, links: [] });
    }
  });

  test("by default the request span starts its own trace and links to the caller", async () => {
    const { app, spans } = harness(false);
    const response = await app.request("/healthz", { headers: { traceparent: HEADER } });
    expect(response.status).toBe(200);
    const span = serverSpan(await spans());
    expect(span.name).toBe("HTTP GET /healthz");
    expect(span.traceId).not.toBe(CALLER.traceId);
    expect(span.parentSpanId).toBeUndefined();
    expect(span.links).toEqual([{ traceId: CALLER.traceId, spanId: CALLER.spanId }]);
  });

  test("a trusting deployment joins the caller's trace as its child", async () => {
    const { app, spans } = harness(true);
    await app.request("/healthz", { headers: { traceparent: HEADER } });
    const span = serverSpan(await spans());
    expect(span.traceId).toBe(CALLER.traceId);
    expect(span.parentSpanId).toBe(CALLER.spanId);
    expect(span.links).toEqual([]);
  });

  test("malformed or repeated headers are ignored even when trusted", async () => {
    for (const traceparent of [`${HEADER}, ${HEADER}`, "00-not-a-trace", `ff-${HEADER.slice(3)}`]) {
      const { app, spans } = harness(true);
      await app.request("/healthz", { headers: { traceparent } });
      const span = serverSpan(await spans());
      expect(span.traceId).not.toBe(CALLER.traceId);
      expect(span.parentSpanId).toBeUndefined();
      expect(span.links).toEqual([]);
    }
  });
});

test("outbound calls made while serving a request are child spans of its request span", async () => {
  const { app, spans, bodies } = harness(true);
  const fetchImpl = traceFetch(
    async (_input: string, _init?: RequestInit) => new Response("{}", { status: 201 }),
  );
  const storage = traceClientCalls(
    {
      async getObjectBytes(_key: string) {
        return null;
      },
    },
    "object_storage",
  );
  app.get("/test-only/outbound", async (c) => {
    await fetchImpl("https://provider.example/private/path?key=abc", { method: "POST" });
    await storage.getObjectBytes("workspace/private-object");
    return c.json({ ok: true });
  });
  const response = await app.request("/test-only/outbound", { headers: { traceparent: HEADER } });
  expect(response.status).toBe(200);
  const exported = await spans();
  const server = serverSpan(exported);
  const children = exported.filter((span) => span.parentSpanId === server.spanId);
  expect(children.map((span) => [span.name, span.kind]).sort()).toEqual([
    ["HTTP POST", 3],
    ["object_storage getObjectBytes", 3],
  ]);
  expect(children.every((span) => span.traceId === CALLER.traceId)).toBe(true);
  const serialized = JSON.stringify(bodies);
  expect(serialized).not.toContain("provider.example");
  expect(serialized).not.toContain("private");
});
