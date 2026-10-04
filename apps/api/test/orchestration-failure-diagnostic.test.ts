import { expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { orchestrationFailureDiagnostic } from "../src/mcp/orchestration-failure-diagnostic";

const caller = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  turnId: "00000000-0000-4000-8000-000000000002",
  attemptId: "00000000-0000-4000-8000-000000000003",
  executionGeneration: 3,
};
const sentinel = "PRIVATE_ERROR_CANARY";

function failure() {
  const driver = Object.assign(new Error(sentinel), {
    name: "PostgresError",
    code: "42501",
    query: sentinel,
    params: [sentinel],
    detail: sentinel,
  });
  driver.stack = `PostgresError: ${sentinel}\n at ${sentinel} (/host/${sentinel}/packages/db/src/index.ts:123:4)`;
  const outer = new Error(sentinel, { cause: driver });
  outer.stack = `Error: ${sentinel}\n at secret (/host/${sentinel}/apps/api/src/mcp/server.ts:500:8)`;
  return outer;
}

test("all orchestration phases retain bounded safe cause evidence without a sink", () => {
  const deps = { settings: testSettings() } as ApiRouteDeps;
  for (const tool of ["session_create", "session_send_message", "session_steer"] as const) {
    const error = failure();
    const result = orchestrationFailureDiagnostic(deps, tool, error, caller);
    expect(result.diagnosticExport).toBe("disabled");
    expect(result.diagnostic).toMatchObject({
      ...caller,
      stage: `mcp.${tool}`,
      sqlState: "42501",
      retryDecision: "unknown",
      causes: [
        { kind: "Error", frames: [{ source: "apps/api/src/mcp/server.ts", line: 500 }] },
        { kind: "PostgresError", frames: [{ source: "packages/db/src/index.ts", line: 123 }] },
      ],
    });
    expect(result.diagnostic).not.toHaveProperty("attempts", expect.any(String));
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(error.message).toBe(sentinel);
  }
});

test("receipt and protected export share exact identity; export is queued, never claimed delivered", async () => {
  const exported: unknown[] = [];
  const settings = testSettings({
    observabilityMetricsEnabled: false,
    observabilityDiagnosticsEndpoint: "http://diagnostics.invalid",
    deploymentRevision: "a".repeat(40),
  });
  const observability = createObservability(settings, {
    component: "api",
    exporter: async (_url, body) => {
      exported.push(body);
    },
  });
  const result = orchestrationFailureDiagnostic(
    { settings, observability },
    "session_create",
    failure(),
    caller,
  );
  expect(result.diagnosticExport).toBe("queued");
  expect(result.diagnostic.deploymentRevision).toBe("a".repeat(40));
  await observability.flush();
  expect(exported).toHaveLength(1);
  const record = JSON.parse(
    (exported[0] as any).resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue,
  );
  expect(record).toEqual(JSON.parse(JSON.stringify(result.diagnostic)));
  expect(JSON.stringify(exported)).not.toContain(sentinel);
});

test("export absence/failure cannot erase retained evidence or invent a caller", () => {
  const settings = testSettings({ observabilityDiagnosticsEndpoint: "http://diagnostics.invalid" });
  for (const observability of [
    undefined,
    {
      recordFailureDiagnostic: () => {
        throw new Error(sentinel);
      },
    },
  ]) {
    const result = orchestrationFailureDiagnostic(
      { settings, observability } as ApiRouteDeps,
      "session_steer",
      failure(),
      null,
    );
    expect(result.diagnosticExport).toBe("unavailable");
    expect(result.diagnostic.sqlState).toBe("42501");
    expect(result.diagnostic.sessionId).toBeUndefined();
    expect(result.diagnostic.attemptId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  }
});
