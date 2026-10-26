import { expect, test } from "bun:test";
import {
  childSpanRecordingActive,
  createObservability,
  currentTraceContext,
  parseTraceparent,
  startChildSpan,
  traceClientCalls,
  traceFetch,
  tracedFetchTarget,
  withTraceContext,
} from "../src";

type ExportedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  links: Array<{ traceId: string; spanId: string }>;
  name: string;
  kind: number;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status: { code: number };
};

function harness(options: { endpoint?: string; exporter?: () => void } = {}) {
  const bodies: unknown[] = [];
  const obs = createObservability(
    {
      serviceName: "test",
      environment: "test",
      observabilityStructuredLogs: false,
      observabilityMetricsEnabled: false,
      observabilityOtlpHeaders: "",
      observabilityOtlpEndpoint:
        options.endpoint === undefined ? "http://collector" : options.endpoint,
    },
    {
      component: "api",
      exporter: async (_url, body) => {
        options.exporter?.();
        bodies.push(body);
      },
    },
  );
  const spans = async (): Promise<ExportedSpan[]> => {
    await obs.flush();
    return bodies.flatMap((body) =>
      (
        body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: ExportedSpan[] }> }> }
      ).resourceSpans.flatMap((resource) => resource.scopeSpans[0]!.spans),
    );
  };
  return { obs, spans, bodies };
}

const attribute = (span: ExportedSpan | undefined, key: string) => {
  const value = span?.attributes.find((entry) => entry.key === key)?.value;
  return value ? Object.values(value)[0] : undefined;
};

test("W3C traceparent parsing follows Trace Context level 1", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const spanId = "00f067aa0ba902b7";
  expect(parseTraceparent(`00-${traceId}-${spanId}-01`)).toEqual({
    traceId,
    spanId,
    traceFlags: "01",
  });
  // A later version is read by its first four fields; more may follow a dash.
  expect(parseTraceparent(`01-${traceId}-${spanId}-01-future`)).toEqual({
    traceId,
    spanId,
    traceFlags: "01",
  });
  for (const invalid of [
    `00-${traceId}-${spanId}-01-extra`,
    `01-${traceId}-${spanId}-01extra`,
    `ff-${traceId}-${spanId}-01`,
    `00-${traceId.toUpperCase()}-${spanId}-01`,
    `00-${"0".repeat(32)}-${spanId}-01`,
    `00-${traceId}-${"0".repeat(16)}-01`,
    `00-${traceId}-${spanId}`,
    // Repeated headers arrive joined with a comma.
    `00-${traceId}-${spanId}-01, 00-${traceId}-${spanId}-01`,
    "",
    undefined,
  ]) {
    expect(parseTraceparent(invalid)).toBeUndefined();
  }
});

test("a root with a child-span budget records nested children with kinds and parents", async () => {
  const { obs, spans } = harness();
  const root = obs.startSpan("HTTP GET /v1/x", {}, { kind: "server", childSpanLimit: 8 });
  await withTraceContext(root, async () => {
    expect(childSpanRecordingActive()).toBe(true);
    const transaction = startChildSpan("db transaction", {}, "internal")!;
    await withTraceContext(transaction, async () => {
      startChildSpan("SELECT sessions", { "db.operation.name": "SELECT" })!.end();
    });
    transaction.end();
  });
  root.end();
  const exported = await spans();
  const byName = (name: string) => exported.find((span) => span.name === name)!;
  expect(byName("HTTP GET /v1/x").kind).toBe(2);
  expect(byName("db transaction")).toMatchObject({
    kind: 1,
    traceId: root.traceId,
    parentSpanId: root.spanId,
  });
  expect(byName("SELECT sessions")).toMatchObject({
    kind: 3,
    traceId: root.traceId,
    parentSpanId: byName("db transaction").spanId,
  });
  expect(attribute(byName("SELECT sessions"), "db.operation.name")).toBe("SELECT");
});

test("the child-span budget is shared by the whole request and reported when spent", async () => {
  const { obs, spans } = harness();
  const root = obs.startSpan("root", {}, { childSpanLimit: 2 });
  withTraceContext(root, () => {
    for (let index = 0; index < 5; index++) startChildSpan(`child ${index}`)?.end();
  });
  root.end();
  // Work that outlives its request records nothing.
  withTraceContext(root, () => {
    expect(startChildSpan("late")).toBeUndefined();
  });
  const exported = await spans();
  expect(exported.map((span) => span.name).sort()).toEqual(["child 0", "child 1", "root"]);
  expect(
    attribute(
      exported.find((span) => span.name === "root"),
      "opengeni.child_spans_dropped",
    ),
  ).toBe(3);
});

test("child spans are not recorded without a budget, without an exporter, or in another trace", () => {
  const unbudgeted = harness();
  withTraceContext(unbudgeted.obs.startSpan("worker attempt"), () => {
    expect(childSpanRecordingActive()).toBe(false);
    expect(startChildSpan("SELECT x")).toBeUndefined();
  });
  const unexported = harness({ endpoint: "" });
  withTraceContext(unexported.obs.startSpan("root", {}, { childSpanLimit: 8 }), () => {
    expect(startChildSpan("SELECT x")).toBeUndefined();
  });
  const { obs } = harness();
  const root = obs.startSpan("root", {}, { childSpanLimit: 8 });
  withTraceContext(root, () => {
    const unrelated = { traceId: "a".repeat(32), spanId: "b".repeat(16) };
    withTraceContext(unrelated, () => {
      expect(childSpanRecordingActive()).toBe(false);
    });
    expect(childSpanRecordingActive()).toBe(true);
  });
  expect(childSpanRecordingActive()).toBe(false);
});

test("telemetry export runs outside the trace it exports", async () => {
  let insideTrace: boolean | undefined;
  const { obs, spans } = harness({
    exporter: () => {
      insideTrace = childSpanRecordingActive() || currentTraceContext() !== undefined;
    },
  });
  const root = obs.startSpan("root", {}, { childSpanLimit: 8 });
  await withTraceContext(root, async () => {
    startChildSpan("child")!.end();
    await obs.flush();
  });
  root.end();
  await spans();
  expect(insideTrace).toBe(false);
});

test("a traced fetch names the fetch it wraps, so transport checks can look through it", () => {
  const base = async () => new Response("ok");
  expect(tracedFetchTarget(base)).toBe(base);
  expect(tracedFetchTarget(traceFetch(base))).toBe(base);
  expect(tracedFetchTarget(traceFetch(traceFetch(base)))).toBe(base);
  // The marker is not an enumerable extra, so wrapping never copies it as one.
  expect(Object.keys(traceFetch(base))).toEqual([]);
  expect(tracedFetchTarget(null)).toBeNull();
});

test("traced fetch records method and status only, and passes through outside a request", async () => {
  const { obs, spans, bodies } = harness();
  const calls: string[] = [];
  const base = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response("ok", { status: 503 });
    },
    { preconnect: () => "kept" },
  );
  const traced = traceFetch(base);
  expect(traced.preconnect()).toBe("kept");
  await traced("https://internal.example/secret-path?token=abc", { method: "post" });
  expect(await spans()).toEqual([]);
  const root = obs.startSpan("root", {}, { childSpanLimit: 8 });
  await withTraceContext(root, async () => {
    const response = await traced("https://internal.example/secret-path?token=abc", {
      method: "post",
    });
    expect(response.status).toBe(503);
    await expect(
      traceFetch(async (_input: string) => {
        throw new TypeError("network down at https://internal.example");
      })("https://internal.example"),
    ).rejects.toThrow("network down");
  });
  root.end();
  const exported = await spans();
  const posts = exported.filter((span) => span.name === "HTTP POST");
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ kind: 3, parentSpanId: root.spanId });
  expect(attribute(posts[0], "http.request.method")).toBe("POST");
  expect(attribute(posts[0], "http.response.status_code")).toBe(503);
  expect(exported.find((span) => span.name === "HTTP GET")?.status.code).toBe(2);
  expect(calls).toHaveLength(2);
  const serialized = JSON.stringify(bodies);
  expect(serialized).not.toContain("internal.example");
  expect(serialized).not.toContain("secret-path");
  expect(serialized).not.toContain("token");
});

test("traced client calls span each method, nest inner work and keep plain fields", async () => {
  const { obs, spans, bodies } = harness();
  const client = traceClientCalls(
    {
      bucket: "private-bucket-name",
      self() {
        return this.bucket;
      },
      async getFileBytes(key: string) {
        startChildSpan("HTTP GET")?.end();
        return key.length;
      },
      async fail(_key: string) {
        throw new Error("object key private/key was missing");
      },
    },
    "object_storage",
  );
  expect(client.bucket).toBe("private-bucket-name");
  expect(client.self()).toBe("private-bucket-name");
  expect(client.getFileBytes).toBe(client.getFileBytes);
  const root = obs.startSpan("root", {}, { childSpanLimit: 8 });
  await withTraceContext(root, async () => {
    expect(await client.getFileBytes("workspace/private-key")).toBe(21);
    await expect(client.fail("private/key")).rejects.toThrow("missing");
  });
  root.end();
  const exported = await spans();
  const get = exported.find((span) => span.name === "object_storage getFileBytes")!;
  expect(get).toMatchObject({ kind: 3, parentSpanId: root.spanId });
  expect(attribute(get, "opengeni.client")).toBe("object_storage");
  expect(attribute(get, "opengeni.client.operation")).toBe("getFileBytes");
  expect(exported.find((span) => span.name === "HTTP GET")?.parentSpanId).toBe(get.spanId);
  expect(exported.find((span) => span.name === "object_storage fail")?.status.code).toBe(2);
  const serialized = JSON.stringify(bodies);
  expect(serialized).not.toContain("private");
});

test("database span attributes pass only their closed shapes", async () => {
  const { obs, spans } = harness();
  const root = obs.startSpan("root", {}, { childSpanLimit: 8 });
  withTraceContext(root, () => {
    startChildSpan("SELECT sessions", {
      "db.system.name": "postgresql",
      "db.operation.name": "SELECT",
      "db.collection.name": "sessions",
    })!.end({ attributes: { "db.response.returned_rows": 3, "db.response.status_code": "23505" } });
    startChildSpan("bad", {
      "db.system.name": "mysql",
      "db.operation.name": "select * from users where email = 'a@b.c'",
      "db.collection.name": "users where email = 'a@b.c'",
      "db.response.status_code": "duplicate key value violates unique constraint",
      "db.query.text": "select 1",
    })!.end();
  });
  root.end();
  const exported = await spans();
  const good = exported.find((span) => span.name === "SELECT sessions");
  expect(attribute(good, "db.system.name")).toBe("postgresql");
  expect(attribute(good, "db.operation.name")).toBe("SELECT");
  expect(attribute(good, "db.collection.name")).toBe("sessions");
  expect(attribute(good, "db.response.returned_rows")).toBe(3);
  expect(attribute(good, "db.response.status_code")).toBe("23505");
  expect(exported.find((span) => span.name === "bad")?.attributes).toEqual([]);
});
