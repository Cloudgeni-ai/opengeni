import { expect, test } from "bun:test";
import { failureDiagnostic } from "../src/failure-diagnostic";
import { createObservability } from "../src";

const sentinel = "SECRET_CANARY_481FA";
test("protected diagnostic retains cause location and typed facts, never arbitrary error text", () => {
  const cause = Object.assign(new Error(sentinel), {
    name: "PostgresError",
    params: [sentinel],
    query: sentinel,
  });
  cause.stack = `PostgresError: ${sentinel}\n    at ${sentinel} (/app/${sentinel}.ts:125:4)`;
  const outer = new Error(sentinel, { cause });
  const record = failureDiagnostic(
    {
      code: "db_failure",
      stage: "failure_settlement",
      retryDecision: "exhausted",
      error: outer,
      sqlState: "23514",
      constraint: "session_events_payload_bytes_check",
      attemptId: "00000000-0000-4000-8000-000000000001",
      attempts: 3,
    },
    "a".repeat(40),
  );
  expect(record.causes).toHaveLength(2);
  expect(record.causes[1]).toMatchObject({
    kind: "PostgresError",
    frames: [{ line: 125, column: 4 }],
  });
  expect(record).toMatchObject({
    sqlState: "23514",
    constraint: "session_events_payload_bytes_check",
    attempts: 3,
    deploymentRevision: "a".repeat(40),
  });
  expect(JSON.stringify(record)).not.toContain(sentinel);
  expect(outer.message).toBe(sentinel);
  expect(cause.stack).toContain(sentinel);
});

test("hostile exception descriptors and cyclic chains are bounded and do not escape", () => {
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        throw new Error(sentinel);
      },
    },
  );
  expect(() =>
    failureDiagnostic({ code: "api_uncaught_exception", stage: "running", error: hostile }),
  ).not.toThrow();
  const cyclic = new Error(sentinel);
  Object.defineProperty(cyclic, "cause", { value: cyclic });
  expect(
    failureDiagnostic({ code: "api_uncaught_exception", stage: "running", error: cyclic }).causes,
  ).toHaveLength(1);
  expect(
    JSON.stringify(
      failureDiagnostic({
        code: "db_failure",
        stage: "preclaim",
        error: hostile,
        constraint: sentinel,
        sessionId: sentinel,
      }),
    ),
  ).not.toContain(sentinel);
});

test("protected sink is separate, opt-in, DB-independent and drainable", async () => {
  const exported: Array<{ url: string; body: unknown; headers: unknown }> = [];
  const settings = {
    serviceName: "test",
    environment: "test",
    observabilityStructuredLogs: true,
    observabilityMetricsEnabled: false,
    observabilityOtlpEndpoint: "http://public",
    observabilityOtlpHeaders: "public=public",
  };
  const options = {
    component: "api",
    exporter: async (url: string, body: unknown, headers: unknown) => {
      exported.push({ url, body, headers });
    },
  };
  const disabled = createObservability(settings, options);
  disabled.recordFailureDiagnostic({
    code: "api_uncaught_exception",
    stage: "running",
    error: new Error(sentinel),
  });
  await disabled.flush();
  expect(exported).toHaveLength(0);
  const obs = createObservability(
    {
      ...settings,
      observabilityDiagnosticsEndpoint: "http://restricted",
      observabilityDiagnosticsHeaders: "private=private",
    },
    options,
  );
  const id = obs.recordFailureDiagnostic({
    code: "api_uncaught_exception",
    stage: "running",
    error: new Error(sentinel),
  });
  obs.startSpan("public").end();
  await obs.flush();
  expect(exported.find((e) => e.url === "http://restricted/v1/logs")!.headers).toEqual({
    private: "private",
  });
  expect(
    JSON.stringify(exported.find((e) => e.url === "http://restricted/v1/logs")!.body),
  ).toContain(id);
  expect(
    JSON.stringify(exported.find((e) => e.url === "http://public/v1/traces")!.body),
  ).not.toContain(id);
  expect(JSON.stringify(exported)).not.toContain(sentinel);
});
