import { describe, expect, test } from "bun:test";
import {
  CONTROL_CTE,
  CANONICAL_RUNNER,
  DATABASE_RUNNER,
  databaseQueries,
  errorComparison,
  memoryBytes,
  parseArgs,
  podFacts,
  sweep,
  textResult,
  applyOwnership,
  ownerClassification,
  safeDatabaseErrorCode,
  type Run,
} from "./staging-health-sweep";

describe("staging health sweep", () => {
  test("defaults to staging and rejects unbounded or injectable arguments", () => {
    expect(parseArgs([]).context).toBe("opengeni-stg-neu-aks-admin");
    expect(parseArgs(["--format", "text"]).format).toBe("text");
    for (const args of [
      ["--wat", "x"],
      ["--namespace", 'a"}'],
      ["--window-minutes", "0"],
      ["--timeout-seconds", "61"],
      ["--format", "yaml"],
    ])
      expect(() => parseArgs(args)).toThrow();
  });
  test("parses Kubernetes memory quantities", () => {
    expect(memoryBytes("2Gi")).toBe(2 * 1024 ** 3);
    expect(memoryBytes("300000Ki")).toBe(300000 * 1024);
    expect(memoryBytes("100M")).toBe(100000000);
    expect(() => memoryBytes("secret")).toThrow();
  });
  test("reports init restarts and OOM without implying windowed history", () => {
    const facts = podFacts({
      items: [
        {
          metadata: { name: "api" },
          status: {
            containerStatuses: [
              { name: "api", restartCount: 2, lastState: { terminated: { reason: "OOMKilled" } } },
            ],
            initContainerStatuses: [{ name: "init", restartCount: 1 }],
          },
        },
      ],
    });
    expect(facts.restartTotal).toBe(3);
    expect(facts.oomContainers).toBe(1);
    expect(facts.coverage).toContain("Deleted pods");
  });
  test("spike compares denominators and does not divide by zero or alert on tiny samples", () => {
    expect(errorComparison({ requests: 100, errors: 5 }, { requests: 1000, errors: 5 }).spike).toBe(
      true,
    );
    expect(errorComparison({ requests: 2, errors: 1 }, { requests: 1000, errors: 5 }).spike).toBe(
      false,
    );
    expect(
      errorComparison({ requests: 0, errors: 0 }, { requests: 0, errors: 0 }).currentRate,
    ).toBeNull();
    expect(
      errorComparison({ requests: 100, errors: 5 }, { requests: 0, errors: 0 }).comparison,
    ).toBe("insufficient_traffic");
    expect(() =>
      errorComparison({ requests: NaN, errors: 0 }, { requests: 1, errors: 0 }),
    ).toThrow();
  });
  test("database contract is read only and respects revision-aware controls and legitimate empty completions", () => {
    expect(DATABASE_RUNNER).toContain("READ ONLY ISOLATION LEVEL REPEATABLE READ");
    expect(DATABASE_RUNNER).toContain("rolsuper OR rolbypassrls");
    expect(DATABASE_RUNNER).toContain("statement_timeout='5000ms'");
    expect(CONTROL_CTE).toContain("descendant_override<=p.direct_pause_revision");
    expect(CONTROL_CTE).toContain("subtree_run_override_revision>w.workspace_pause_revision");
    expect(CONTROL_CTE).toContain("p.cycle OR p.depth>=10000");
    const q = databaseQueries();
    expect(q.empty).toContain("emptyFinalReply");
    expect(q.empty).toContain("tool_only");
    expect(q.empty).toContain("awaiting_input");
    expect(q.empty).toContain("count(DISTINCT turn_id)>=2");
    expect(q.latency).toContain("started_at-created_at");
    expect(q.recovering).toContain("missingStatusTimestamp");
    expect(q.queued).not.toContain("OR finished_at");
    expect(q.recovering).not.toContain("OR finished_at");
  });
  test("unavailable sources remain explicit gaps without leaking errors", async () => {
    const result = await sweep(parseArgs([]), async () => {
      throw new Error("postgres://user:secret@host");
    });
    expect(result.exitCode).toBe(2);
    expect(result.checks).toHaveLength(7);
    expect(result.checks.every((c) => c.status === "gap")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(textResult(result)).toContain("GAP queued");
  });
  test("extracts Bun SQLSTATE errno and wrapped database codes without returning raw errors", () => {
    expect(safeDatabaseErrorCode({ code: "ERR_POSTGRES_SERVER_ERROR", errno: "57014" })).toBe(
      "57014",
    );
    expect(safeDatabaseErrorCode({ cause: { errno: "42703" } })).toBe("42703");
    expect(safeDatabaseErrorCode({ code: "postgres://user:secret@host" })).toBe("unavailable");
    expect(safeDatabaseErrorCode(new Error("postgres://user:secret@host"))).toBe("unavailable");
    expect(safeDatabaseErrorCode(null)).toBe("unavailable");
  });
  test("collects healthy sources, records all metrics, and passes credentials through stdin only", async () => {
    const now = new Date("2026-10-03T11:00:00Z");
    const options = parseArgs(["--database-secret", "reader"]);
    const commands: string[][] = [];
    const run: Run = async (args, stdin) => {
      commands.push(args);
      if (args.includes("secret"))
        return JSON.stringify({
          data: {
            OPENGENI_MIGRATIONS_DATABASE_URL:
              Buffer.from("postgres://credential").toString("base64"),
          },
        });
      if (args.includes("exec")) {
        expect(JSON.parse(stdin!).url).toBe("postgres://credential");
        return JSON.stringify({
          queued: { total: 0, runnable: 0, controlUnknown: 0 },
          recovering: { total: 0, controlUnknown: 0, missingStatusTimestamp: 0 },
          empty: { sample: 3, suspectTurns: 0, repeatedSessions: 0, controlUnknown: 0 },
          latency: { sample: 3, p50Seconds: 1, p95Seconds: 2, invalidNegativeSamples: 0 },
        });
      }
      if (args.includes("pods"))
        return JSON.stringify({
          items: [
            {
              metadata: { name: "api", labels: { "app.kubernetes.io/component": "api" } },
              spec: { containers: [{ name: "api", resources: { limits: { memory: "2Gi" } } }] },
              status: { phase: "Running", containerStatuses: [{ name: "api", restartCount: 0 }] },
            },
          ],
        });
      if (args.at(-1)?.includes("metrics.k8s.io"))
        return JSON.stringify({
          items: [
            {
              metadata: { name: "api" },
              timestamp: now.toISOString(),
              window: "1m",
              containers: [{ name: "api", usage: { memory: "500Mi" } }],
            },
          ],
        });
      return JSON.stringify({
        status: "success",
        data: {
          result: [
            {
              value: [
                0,
                args.at(-1)?.includes("min(up") || args.at(-1)?.includes("min%28up")
                  ? "1"
                  : args.at(-1)?.includes("status%3D")
                    ? "0"
                    : "100",
              ],
            },
          ],
        },
      });
    };
    const result = await sweep(options, run, now);
    expect(result.schemaVersion).toBe("opengeni.staging-health-sweep.v2");
    expect(result.exitCode).toBe(0);
    expect(result.checks.map((c) => c.id)).toEqual([
      "api-error-rate",
      "api-memory",
      "empty",
      "latency",
      "pod-restarts-oom",
      "queued",
      "recovering",
    ]);
    expect(JSON.stringify(commands)).not.toContain("postgres://credential");
    expect(commands.some((args) => args.includes("get"))).toBe(true);
    expect(commands.every((args) => !args.includes("apply") && !args.includes("patch"))).toBe(true);
  });
  test("missing Prometheus series are gaps, not zero error rate", async () => {
    const run: Run = async () => JSON.stringify({ status: "success", data: { result: [] } });
    const result = await sweep(parseArgs([]), run);
    expect(result.checks.find((c) => c.id === "api-error-rate")?.status).toBe("gap");
  });
  test("malformed database results cannot report healthy", async () => {
    const previous = process.env.OPENGENI_HEALTH_DATABASE_URL;
    process.env.OPENGENI_HEALTH_DATABASE_URL = "postgres://not-printed";
    try {
      const result = await sweep(parseArgs([]), async (args) =>
        args.includes("exec")
          ? JSON.stringify({ queued: {}, recovering: {}, empty: {}, latency: {} })
          : "{}",
      );
      for (const id of ["queued", "recovering", "empty", "latency"])
        expect(result.checks.find((c) => c.id === id)?.status).toBe("gap");
      expect(JSON.stringify(result)).not.toContain("not-printed");
    } finally {
      if (previous === undefined) delete process.env.OPENGENI_HEALTH_DATABASE_URL;
      else process.env.OPENGENI_HEALTH_DATABASE_URL = previous;
    }
  });
  test("stale API memory samples are explicit gaps", async () => {
    const run: Run = async (args) =>
      args.includes("pods")
        ? JSON.stringify({
            items: [
              {
                metadata: { name: "api", labels: { "app.kubernetes.io/component": "api" } },
                status: { phase: "Running" },
                spec: { containers: [] },
              },
            ],
          })
        : args.at(-1)?.includes("metrics.k8s.io")
          ? JSON.stringify({
              items: [
                { metadata: { name: "api" }, timestamp: "2026-10-03T10:00:00Z", containers: [] },
              ],
            })
          : "{}";
    const result = await sweep(parseArgs([]), run, new Date("2026-10-03T11:00:00Z"));
    expect(result.checks.find((c) => c.id === "api-memory")?.status).toBe("gap");
  });
  test("canonical observer uses exact read APIs, always rolls back, and offers no wake/recovery services", () => {
    expect(CANONICAL_RUNNER).toContain("evaluateSessionControl(tx");
    expect(CANONICAL_RUNNER).toContain("activities.peekSessionWork");
    expect(CANONICAL_RUNNER).toContain("runId:ref.workflowRunId");
    expect(CANONICAL_RUNNER).toContain("a.activityId===ref.activityId");
    expect(CANONICAL_RUNNER).toContain("throw rollback");
    expect(CANONICAL_RUNNER).toContain("rollbackProven=error===rollback");
    expect(CANONICAL_RUNNER).not.toContain("signalWithStart");
    expect(CANONICAL_RUNNER).not.toContain("requestSessionTurnRecovery");
    expect(CANONICAL_RUNNER).not.toContain("wakeSessionWorkflow:");
  });
  test("pending exact owner is not stranded; settled owner is only a candidate, unknown owner is a gap", () => {
    const observation = {
      session_id: "s",
      workspace_id: "w",
      state: "active" as const,
      kind: "attempt-owned",
      turnId: "t",
      attemptId: "a",
      executionGeneration: 1,
      activityRef: { workflowId: "wf", workflowRunId: "run", activityId: "activity" },
    };
    expect(ownerClassification({ ...observation, ownerActivityState: "pending" })).toBe(
      "active_owner",
    );
    expect(ownerClassification({ ...observation, ownerActivityState: "settled" })).toBe(
      "settled_owner_candidate",
    );
    expect(ownerClassification({ ...observation, ownerActivityState: "unknown" })).toBe("unknown");
    expect(
      ownerClassification({ ...observation, ownerActivityState: "settled", activityRef: null }),
    ).toBe("unknown");
  });
  test("canonical pause, input wait, admission block, and stopping settlement exclude age-only findings", () => {
    const base = { session_id: "s", workspace_id: "w", state: "active" as const, settlement: null };
    expect(ownerClassification({ ...base, state: "paused", kind: "runnable" })).toBe("paused");
    expect(ownerClassification({ ...base, kind: "input-wait" })).toBe("input-wait");
    expect(ownerClassification({ ...base, kind: "admission-blocked" })).toBe("admission-blocked");
    expect(ownerClassification({ ...base, kind: "runnable", settlement: "stopping" })).toBe(
      "settlement_wait",
    );
    expect(ownerClassification({ ...base, kind: "runnable" })).toBe("runnable_candidate");
  });
  test("ownership coverage is fail closed when capped lists or observations omit candidates", () => {
    const facts = {
      total: 3,
      runnable: 3,
      excluded: {},
      sessions: [{ session_id: "s", workspace_id: "w", reason: "runnable" }],
    };
    const result = applyOwnership(facts, [
      { session_id: "s", workspace_id: "w", state: "active", settlement: null, kind: "runnable" },
    ]);
    expect(result.actionable).toBe(1);
    expect(result.ownerUnknown).toBe(2);
    expect(result.sqlRunnableCandidates).toBe(3);
    expect(result).not.toHaveProperty("runnable");
    expect(applyOwnership({ ...facts, runnable: 1 }, []).ownerUnknown).toBe(1);
  });
});
