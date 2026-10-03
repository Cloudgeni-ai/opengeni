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
  boundedRun,
  OWNER_PAGE_SIZE,
  type OwnerObservation,
  type Run,
} from "./staging-health-sweep";

function healthyRun(
  overrides: {
    memory?: unknown;
    limit?: unknown;
    current?: { requests: number; errors: number };
    baseline?: { requests: number; errors: number };
    database?: Record<string, unknown>;
    owners?: OwnerObservation[];
  } = {},
): Run {
  return async (args) => {
    if (args.includes("exec") && args.at(-1) === CANONICAL_RUNNER)
      return JSON.stringify(overrides.owners ?? []);
    if (args.includes("secret"))
      return JSON.stringify({
        data: {
          OPENGENI_MIGRATIONS_DATABASE_URL: Buffer.from("postgres://fixture").toString("base64"),
        },
      });
    if (args.includes("exec"))
      return JSON.stringify({
        queued: { total: 0, runnable: 0, controlUnknown: 0 },
        queuedInventory: { total: 0, sessions: [] },
        recovering: { total: 0, controlUnknown: 0, missingStatusTimestamp: 0 },
        empty: {
          sample: 3,
          suspectTurns: 0,
          repeatedSessions: 0,
          controlUnknown: 0,
          missingCompletionEvidence: 0,
        },
        latency: {
          sample: 3,
          p50Seconds: 1,
          p95Seconds: 2,
          invalidNegativeSamples: 0,
          missingFirstStartEvents: 0,
          futureFirstStartEvents: 0,
        },
        ...overrides.database,
      });
    if (args.includes("pods"))
      return JSON.stringify({
        items: [
          {
            metadata: { name: "api", labels: { "app.kubernetes.io/component": "api" } },
            spec: {
              containers: [
                { name: "api", resources: { limits: { memory: overrides.limit ?? "2Gi" } } },
              ],
            },
            status: { phase: "Running", containerStatuses: [{ name: "api", restartCount: 0 }] },
          },
        ],
      });
    if (args.at(-1)?.includes("metrics.k8s.io"))
      return JSON.stringify({
        items: [
          {
            metadata: { name: "api" },
            timestamp: "2026-10-03T11:00:00Z",
            window: "1m",
            containers: [{ name: "api", usage: { memory: overrides.memory ?? "500Mi" } }],
          },
        ],
      });
    const query = decodeURIComponent(args.at(-1) ?? "");
    const counts = query.includes(" offset ") ? overrides.baseline : overrides.current;
    const value = query.includes("min(up")
      ? 1
      : query.includes('status=~"5.."')
        ? (counts?.errors ?? 0)
        : (counts?.requests ?? 100);
    return JSON.stringify({ status: "success", data: { result: [{ value: [0, String(value)] }] } });
  };
}

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
      ["--queue-offset", "-1"],
      ["--recovery-offset", "1.5"],
      ["--inventory-offset", "1000001"],
    ])
      expect(() => parseArgs(args)).toThrow();
    expect(parseArgs(["--queue-offset", "20", "--recovery-offset", "0"]).queueOffset).toBe(20);
    expect(() => databaseQueries({ queueOffset: NaN })).toThrow();
  });
  test("parses Kubernetes memory quantities", () => {
    expect(memoryBytes("2Gi")).toBe(2 * 1024 ** 3);
    expect(memoryBytes("300000Ki")).toBe(300000 * 1024);
    expect(memoryBytes("100M")).toBe(100000000);
    expect(memoryBytes("1e3")).toBe(1000);
    expect(memoryBytes("0")).toBe(0);
    for (const value of ["1.2.3Gi", "-1Gi", "1e999", "NaNGi", "Infinity", {}, 100])
      expect(() => memoryBytes(value)).toThrow();
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
    expect(() =>
      errorComparison({ requests: 100, errors: 101 }, { requests: 0, errors: 0 }),
    ).toThrow();
    expect(() => errorComparison({ requests: 0, errors: 0 }, { requests: 0, errors: 1 })).toThrow();
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
    expect(q.latency).toContain("first_started_at-created_at");
    expect(q.recovering).toContain("missingStatusTimestamp");
    expect(q.queued).not.toContain("OR finished_at");
    expect(q.recovering).not.toContain("OR finished_at");
  });
  test("unavailable sources remain explicit gaps without leaking errors", async () => {
    const result = await sweep(parseArgs([]), async () => {
      throw new Error("postgres://user:secret@host");
    });
    expect(result.exitCode).toBe(2);
    expect(result.checks).toHaveLength(8);
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
          queuedInventory: { total: 0, sessions: [] },
          recovering: { total: 0, controlUnknown: 0, missingStatusTimestamp: 0 },
          empty: {
            sample: 3,
            suspectTurns: 0,
            repeatedSessions: 0,
            controlUnknown: 0,
            missingCompletionEvidence: 0,
          },
          latency: {
            sample: 3,
            p50Seconds: 1,
            p95Seconds: 2,
            invalidNegativeSamples: 0,
            missingFirstStartEvents: 0,
            futureFirstStartEvents: 0,
          },
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
      "queued-inventory",
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
      sessions: [
        {
          session_id: "s",
          workspace_id: "w",
          reason: "runnable",
          queued_at: "2026-10-03T10:00:00Z",
        },
      ],
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
  test("first-start latency uses earliest nonduplicate durable event, not overwritten resume timestamp", () => {
    const query = databaseQueries().latency!;
    expect(query).toContain("min(e.created_at) first_started_at");
    expect(query).toContain("e.type='turn.started' AND e.duplicate_of_event_id IS NULL");
    expect(query).toContain("first_started_at-created_at");
    expect(query).not.toContain("FROM started_at-created_at");
    expect(query).toContain("resumedFromBeforeWindow");
    expect(query).toContain("missingFirstStartEvents");
  });
  test("missing first-start event evidence is a source gap even with numeric percentiles", async () => {
    const result = await sweep(parseArgs(["--database-secret", "reader"]), async (args) => {
      if (args.includes("secret"))
        return JSON.stringify({
          data: {
            OPENGENI_MIGRATIONS_DATABASE_URL: Buffer.from("postgres://unused").toString("base64"),
          },
        });
      if (args.includes("exec"))
        return JSON.stringify({
          latency: {
            sample: 3,
            p50Seconds: 1,
            p95Seconds: 2,
            invalidNegativeSamples: 0,
            missingFirstStartEvents: 1,
            futureFirstStartEvents: 0,
          },
        });
      return "{}";
    });
    const latency = result.checks.find((check) => check.id === "latency")!;
    expect(latency.status).toBe("gap");
    expect(latency.facts?.missingFirstStartEvents).toBe(1);
    expect(latency.definition).toContain("FIRST");
  });
  test("malformed API usage or limits fail closed rather than emitting OK/null bytes", async () => {
    for (const overrides of [
      { memory: "1.2.3Gi" },
      { memory: "1e999" },
      { limit: "-2Gi" },
      { limit: "1.2.3Gi" },
    ]) {
      const result = await sweep(
        parseArgs(["--database-secret", "reader"]),
        healthyRun(overrides),
        new Date("2026-10-03T11:00:00Z"),
      );
      const memory = result.checks.find((check) => check.id === "api-memory")!;
      expect(memory.status).toBe("gap");
      expect(memory).not.toHaveProperty("facts");
    }
  });
  test("missing traffic comparison is an explicit gap with numerator/denominator facts", async () => {
    for (const counts of [
      { current: { requests: 100, errors: 50 }, baseline: { requests: 0, errors: 0 } },
      { current: { requests: 0, errors: 0 }, baseline: { requests: 100, errors: 0 } },
    ]) {
      const result = await sweep(
        parseArgs(["--database-secret", "reader"]),
        healthyRun(counts),
        new Date("2026-10-03T11:00:00Z"),
      );
      const comparison = result.checks.find((check) => check.id === "api-error-rate")!;
      expect(comparison.status).toBe("gap");
      expect(comparison.facts?.comparison).toBe("insufficient_traffic");
      expect(comparison.facts?.current).toEqual(counts.current);
      expect(comparison.facts?.baseline).toEqual(counts.baseline);
      expect(result.exitCode).toBe(2);
    }
  });
  test("missing usable completion evidence preserves denominator and is a gap", async () => {
    const empty = {
      sample: 3,
      suspectTurns: 0,
      repeatedSessions: 0,
      controlUnknown: 0,
      missingCompletionEvidence: 2,
    };
    const result = await sweep(
      parseArgs(["--database-secret", "reader"]),
      healthyRun({ database: { empty } }),
      new Date("2026-10-03T11:00:00Z"),
    );
    const check = result.checks.find((value) => value.id === "empty")!;
    expect(check.status).toBe("gap");
    expect(check.facts?.sample).toBe(3);
    expect(check.facts?.missingCompletionEvidence).toBe(2);
  });
  test("canonical runnable work with unknown accepted-work age is not claimed overdue", () => {
    const facts = {
      total: 0,
      runnable: 1,
      excluded: {},
      sessions: [
        {
          session_id: "s",
          workspace_id: "w",
          reason: "runnable",
          queued_at: null,
          age_source: "unknown",
        },
      ],
    };
    const observed = [
      {
        session_id: "s",
        workspace_id: "w",
        state: "active" as const,
        settlement: null,
        kind: "runnable",
      },
    ];
    const unknown = applyOwnership(facts, observed);
    expect(unknown.unknownQueueAge).toBe(1);
    expect(unknown.actionable).toBe(0);
    expect(unknown.ownershipClassifications.queue_age_unknown).toBe(1);
    const known = applyOwnership(
      {
        ...facts,
        total: 1,
        sessions: [
          {
            ...facts.sessions[0],
            queued_at: "2026-10-03T10:00:00Z",
            age_source: "pending_system_update",
          },
        ],
      },
      observed,
    );
    expect(known.unknownQueueAge).toBe(0);
    expect(known.actionable).toBe(1);
  });
  test("unknown accepted-work age propagates to a sweep gap with canonical evidence retained", async () => {
    const queued = {
      total: 0,
      runnable: 1,
      controlUnknown: 0,
      excluded: {},
      sessions: [
        {
          session_id: "s",
          workspace_id: "w",
          reason: "runnable",
          queued_at: null,
          age_source: "unknown",
        },
      ],
    };
    const owners: OwnerObservation[] = [
      { session_id: "s", workspace_id: "w", state: "active", settlement: null, kind: "runnable" },
    ];
    const result = await sweep(
      parseArgs(["--database-secret", "reader"]),
      healthyRun({ database: { queued }, owners }),
      new Date("2026-10-03T11:00:00Z"),
    );
    const check = result.checks.find((value) => value.id === "queued")!;
    expect(check.status).toBe("gap");
    expect(check.facts?.unknownQueueAge).toBe(1);
    expect(check.facts?.actionable).toBe(0);
    expect(check.facts?.ownerUnknown).toBe(0);
    expect(result.exitCode).toBe(2);
  });
  test("global inventory timeout cannot discard independently collected known-aged counts", async () => {
    const queued = {
      total: 1,
      runnable: 1,
      controlUnknown: 0,
      excluded: {},
      sessions: [
        {
          session_id: "s",
          workspace_id: "w",
          reason: "runnable",
          queued_at: "2026-10-03T10:00:00Z",
          age_source: "queued_human_api_turn",
        },
      ],
    };
    const owners: OwnerObservation[] = [
      { session_id: "s", workspace_id: "w", state: "active", settlement: null, kind: "runnable" },
    ];
    const healthy = healthyRun({ database: { queued }, owners });
    const batches: string[][] = [];
    const run: Run = async (args, stdin) => {
      if (args.includes("exec") && args.at(-1) === DATABASE_RUNNER) {
        const names = Object.keys(JSON.parse(stdin!).queries);
        batches.push(names);
        if (names.includes("queued")) {
          expect(names).toEqual(["queued"]);
          return JSON.stringify({ queued });
        }
        expect(names).toContain("queuedInventory");
        const other = JSON.parse(await healthy(args, stdin));
        return JSON.stringify({
          ...other,
          queuedInventory: {
            gap: "database_query_failed_or_global_read_role_unavailable",
            code: "57014",
          },
        });
      }
      return healthy(args, stdin);
    };
    const result = await sweep(
      parseArgs(["--database-secret", "reader"]),
      run,
      new Date("2026-10-03T11:00:00Z"),
    );
    expect(batches).toHaveLength(2);
    const known = result.checks.find((check) => check.id === "queued")!;
    const inventory = result.checks.find((check) => check.id === "queued-inventory")!;
    expect(known.facts?.total).toBe(1);
    expect(known.facts?.actionable).toBe(1);
    expect(known.status).toBe("finding");
    expect(inventory.status).toBe("gap");
    expect(inventory.facts?.sourceErrorCode).toBe("57014");
    expect(result.exitCode).toBe(2);
  });
  test("orphan inventory coverage and runnable unknown age remain fail closed", async () => {
    const row = {
      session_id: "unknown",
      workspace_id: "w",
      queued_at: null,
      age_source: "unknown",
      reason: "unknown_age",
    };
    const owners: OwnerObservation[] = [
      {
        session_id: "unknown",
        workspace_id: "w",
        state: "active",
        settlement: null,
        kind: "runnable",
      },
    ];
    const result = await sweep(
      parseArgs(["--database-secret", "reader"]),
      healthyRun({ database: { queuedInventory: { total: 3, sessions: [row] } }, owners }),
      new Date("2026-10-03T11:00:00Z"),
    );
    const inventory = result.checks.find((check) => check.id === "queued-inventory")!;
    expect(inventory.status).toBe("gap");
    expect(inventory.facts?.unknownQueueAge).toBe(1);
    expect(inventory.facts?.ownerUnknown).toBe(2);
    expect(inventory.facts?.actionable).toBe(0);
    expect(inventory.facts).not.toHaveProperty("sqlRunnableCandidates");
  });
  test("recovery and inventory have independent coverage even when a full queue page fails", async () => {
    const queue = Array.from({ length: OWNER_PAGE_SIZE }, (_, index) => ({
      session_id: `q${index}`,
      workspace_id: "w",
      reason: "runnable",
      queued_at: "2026-10-03T10:00:00Z",
    }));
    const recoveries = ["r1", "r2"].map((session_id) => ({ session_id, workspace_id: "w" }));
    const inventory = [{ session_id: "i1", workspace_id: "w", queued_at: null }];
    const healthy = healthyRun({
      database: {
        queued: {
          total: 65,
          runnable: 60,
          excluded: { behind_active_turn: 5 },
          controlUnknown: 0,
          sessions: queue,
        },
        recovering: {
          total: 2,
          controlUnknown: 0,
          missingStatusTimestamp: 0,
          sessions: recoveries,
        },
        queuedInventory: { total: 1, sessions: inventory },
      },
    });
    const phases: string[][] = [];
    const run: Run = async (args, stdin) => {
      if (args.at(-1) !== CANONICAL_RUNNER) return healthy(args, stdin);
      const { targets } = JSON.parse(stdin!);
      phases.push(targets.map((target: any) => target.session_id));
      expect(targets.length).toBeLessThanOrEqual(OWNER_PAGE_SIZE);
      if (targets[0].session_id.startsWith("q")) throw new Error("secret failed queue source");
      return JSON.stringify(
        targets.map((target: any) => ({ ...target, state: "active", kind: "idle" })),
      );
    };
    const result = await sweep(
      parseArgs(["--database-secret", "reader"]),
      run,
      new Date("2026-10-03T11:00:00Z"),
    );
    expect(phases.map((phase) => phase[0])).toEqual(["r1", "q0", "i1"]);
    const recovery = result.checks.find((check) => check.id === "recovering")!;
    expect(recovery.status).toBe("ok");
    expect(recovery.facts?.ownerUnknown).toBe(0);
    expect((recovery.facts!.canonicalPage as any).observed).toBe(2);
    const known = result.checks.find((check) => check.id === "queued")!;
    expect(known.status).toBe("gap");
    expect(known.facts?.ownerUnknown).toBe(65);
    expect((known.facts!.canonicalPage as any).continuationArgs).toEqual(["--queue-offset", "20"]);
    expect(result.checks.find((check) => check.id === "queued-inventory")!.status).toBe("ok");
    expect(result.exitCode).toBe(2);
    expect(JSON.stringify(result)).not.toContain("secret failed");
  });
  test("explicit canonical pages cover disjoint queue candidates without claiming global health", () => {
    const all = Array.from({ length: 45 }, (_, index) => ({
      session_id: `s${String(index).padStart(2, "0")}`,
      workspace_id: "w",
      reason: "runnable",
      queued_at: "2026-10-03T10:00:00Z",
    }));
    const visited: string[] = [];
    for (const offset of [0, 20, 40]) {
      const sessions = all.slice(offset, offset + OWNER_PAGE_SIZE);
      visited.push(...sessions.map((row) => row.session_id));
      const observed: OwnerObservation[] = sessions.map((row) => ({
        ...row,
        state: "active",
        settlement: null,
        kind: "runnable",
      }));
      const facts = applyOwnership(
        { total: 45, runnable: 45, excluded: {}, pageOffset: offset, sessions },
        observed,
      );
      expect(facts.sqlRunnableCandidates).toBe(45);
      expect(facts.actionable).toBe(sessions.length);
      expect(facts.ownerUnknown).toBe(45 - sessions.length);
      expect(facts.incompleteOwnerPage).toBe(0);
      expect(facts.canonicalPage.nextOffset).toBe(offset === 40 ? null : offset + 20);
      expect(facts.canonicalPage.observed).toBe(sessions.length);
      expect(facts.canonicalPage.coverage).toContain("no cross-page health claim");
    }
    expect(new Set(visited).size).toBe(45);
    expect(visited).toEqual(all.map((row) => row.session_id));
    const recovered = applyOwnership(
      { total: 45, pageOffset: 20, sessions: all.slice(20, 40) },
      [],
      true,
    );
    expect(recovered.canonicalPage.continuationArgs).toEqual(["--recovery-offset", "40"]);
    expect(recovered.ownerUnknown).toBe(45);
    const missing = applyOwnership({ total: 1, runnable: 1, sessions: [] }, []);
    expect(missing.incompleteOwnerPage).toBe(1);
    expect(missing.canonicalPage.nextOffset).toBeNull();
  });
  test.skipIf(process.env.OPENGENI_HEALTH_SWEEP_LIVE_TESTS !== "1")(
    "read-only SQL fixtures retain missing completions and pending work across session projections",
    async () => {
      const run = boundedRun(20);
      const kube = ["kubectl", "--context", "opengeni-stg-neu-aks", "-n", "opengeni"];
      const secret = JSON.parse(
        await run([...kube, "get", "secret", "opengeni-migrations", "-o", "json"]),
      );
      const url = Buffer.from(secret.data.OPENGENI_MIGRATIONS_DATABASE_URL, "base64").toString();
      const table = (name: string, columns: string, rows: object[]) =>
        `${name} AS (SELECT * FROM jsonb_to_recordset('${JSON.stringify(rows).replaceAll("'", "''")}'::jsonb) AS fixture(${columns}))`;
      const sessions = (rows: { id: string; status: string }[]) =>
        table(
          "sessions",
          "id text,workspace_id text,parent_session_id text,direct_control_state text,direct_pause_revision bigint,subtree_run_override_revision bigint,status text,input_wait_until timestamptz,created_at timestamptz",
          rows.map((row) => ({
            ...row,
            workspace_id: "w",
            direct_control_state: "active",
            created_at: "2020-01-01T00:00:00Z",
          })),
        );
      const control = table(
        "workspace_inference_controls",
        "workspace_id text,workspace_state text,workspace_pause_revision bigint",
        [{ workspace_id: "w", workspace_state: "active" }],
      );
      const query = (
        name: "queued" | "queuedInventory" | "recovering" | "empty",
        fixtures: string[],
        pages: Parameters<typeof databaseQueries>[0] = {},
      ) => {
        const productionQuery = databaseQueries(pages)[name]!;
        return (
          "WITH RECURSIVE " +
          fixtures.join(",") +
          "," +
          productionQuery.replace(/^WITH RECURSIVE /, "")
        );
      };
      const queueTables = [
        sessions([
          { id: "fresh", status: "queued" },
          { id: "old-update", status: "queued" },
          { id: "human-idle", status: "idle" },
          { id: "api-running", status: "running" },
          { id: "internal-idle", status: "idle" },
          { id: "unknown", status: "queued" },
        ]),
        control,
        table(
          "session_turns",
          "id text,workspace_id text,session_id text,status text,source text,created_at timestamptz",
          [
            {
              id: "human",
              workspace_id: "w",
              session_id: "human-idle",
              status: "queued",
              source: "user",
              created_at: "2026-10-03T12:56:00Z",
            },
            {
              id: "api",
              workspace_id: "w",
              session_id: "api-running",
              status: "queued",
              source: "api",
              created_at: "2026-10-03T12:55:00Z",
            },
            {
              id: "internal",
              workspace_id: "w",
              session_id: "internal-idle",
              status: "queued",
              source: "goal",
              created_at: "2020-01-01T00:00:00Z",
            },
          ],
        ),
        table(
          "session_system_updates",
          "workspace_id text,session_id text,state text,created_at timestamptz",
          [
            {
              workspace_id: "w",
              session_id: "fresh",
              state: "pending",
              created_at: "2026-10-03T12:59:00Z",
            },
            {
              workspace_id: "w",
              session_id: "old-update",
              state: "pending",
              created_at: "2026-10-03T12:57:00Z",
            },
          ],
        ),
      ];
      const queued = query("queued", queueTables);
      const queuedInventory = query("queuedInventory", queueTables);
      const pageIds = Array.from(
        { length: 45 },
        (_, index) => `page${String(index).padStart(2, "0")}`,
      );
      const pagedTables = (status: string, pendingTurns: boolean) => [
        sessions(pageIds.map((id) => ({ id, status }))),
        control,
        table(
          "session_turns",
          "id text,workspace_id text,session_id text,status text,source text,created_at timestamptz",
          pendingTurns
            ? pageIds.map((session_id) => ({
                id: `turn-${session_id}`,
                workspace_id: "w",
                session_id,
                status: "queued",
                source: "api",
                created_at: "2026-10-03T12:50:00Z",
              }))
            : [],
        ),
        table(
          "session_system_updates",
          "workspace_id text,session_id text,state text,created_at timestamptz",
          [],
        ),
        table(
          "session_events",
          "workspace_id text,session_id text,type text,created_at timestamptz,payload jsonb,sequence int",
          pageIds.map((session_id) => ({
            workspace_id: "w",
            session_id,
            type: "session.status.changed",
            created_at: "2026-10-03T12:50:00Z",
            payload: { status: "recovering" },
            sequence: 1,
          })),
        ),
      ];
      const pageQueries = {
        queueFirst: query("queued", pagedTables("recovering", true)),
        queueNext: query("queued", pagedTables("recovering", true), { queueOffset: 20 }),
        queueLast: query("queued", pagedTables("recovering", true), { queueOffset: 40 }),
        recoveryNext: query("recovering", pagedTables("recovering", true), { recoveryOffset: 20 }),
        inventoryNext: query("queuedInventory", pagedTables("queued", false), {
          inventoryOffset: 20,
        }),
      };
      const empty = query("empty", [
        sessions([{ id: "completed", status: "idle" }]),
        control,
        table(
          "session_turns",
          "id text,workspace_id text,session_id text,status text,source text,finished_at timestamptz",
          ["valid", "missing", "malformed"].map((id) => ({
            id,
            workspace_id: "w",
            session_id: "completed",
            status: "completed",
            source: "user",
            finished_at: "2026-10-03T12:55:00Z",
          })),
        ),
        table(
          "session_events",
          "id text,workspace_id text,session_id text,turn_id text,type text,created_at timestamptz,payload jsonb,sequence int,duplicate_of_event_id text",
          [
            {
              id: "v",
              workspace_id: "w",
              session_id: "completed",
              turn_id: "valid",
              type: "turn.completed",
              created_at: "2026-10-03T12:55:00Z",
              payload: { output: "usable" },
              sequence: 1,
            },
            {
              id: "d",
              workspace_id: "w",
              session_id: "completed",
              turn_id: "missing",
              type: "turn.completed",
              created_at: "2026-10-03T12:55:00Z",
              payload: { output: "duplicate" },
              sequence: 2,
              duplicate_of_event_id: "earlier",
            },
            {
              id: "m",
              workspace_id: "w",
              session_id: "completed",
              turn_id: "malformed",
              type: "turn.completed",
              created_at: "2026-10-03T12:55:00Z",
              payload: [],
              sequence: 3,
            },
          ],
        ),
      ]);
      const result = JSON.parse(
        await run(
          [...kube, "exec", "-i", "deployment/opengeni-api", "--", "bun", "-e", DATABASE_RUNNER],
          JSON.stringify({
            url,
            now: "2026-10-03T13:00:00Z",
            windowMinutes: 30,
            queries: { queued, queuedInventory, empty, ...pageQueries },
          }),
        ),
      );
      expect(result.queued).not.toHaveProperty("gap");
      expect(result.queued.total).toBe(3);
      expect(result.queued.unknownAgeCandidates).toBe(0);
      for (const [name, offset] of [
        ["queueFirst", 0],
        ["queueNext", 20],
        ["queueLast", 40],
        ["recoveryNext", 20],
        ["inventoryNext", 20],
      ] as const) {
        const page = result[name];
        expect(page).not.toHaveProperty("gap");
        expect(page.total).toBe(45);
        expect(page.pageOffset).toBe(offset);
        expect(page.sessions.map((row: any) => row.session_id)).toEqual(
          pageIds.slice(offset, offset + OWNER_PAGE_SIZE),
        );
      }
      expect(
        new Set(
          [result.queueFirst, result.queueNext, result.queueLast].flatMap((page: any) =>
            page.sessions.map((row: any) => row.session_id),
          ),
        ).size,
      ).toBe(45);
      expect(result.queued.sessions.map((row: any) => row.session_id).sort()).toEqual([
        "api-running",
        "human-idle",
        "old-update",
      ]);
      expect(
        result.queued.sessions.find((row: any) => row.session_id === "old-update").queued_at,
      ).toStartWith("2026-10-03T12:57:00");
      const observations = result.queued.sessions.map((row: any) => ({
        session_id: row.session_id,
        workspace_id: row.workspace_id,
        state: "active",
        settlement: null,
        kind: "runnable",
      }));
      expect(applyOwnership(result.queued, observations).unknownQueueAge).toBe(0);
      expect(applyOwnership(result.queued, observations).actionable).toBe(3);
      expect(result.queuedInventory).not.toHaveProperty("gap");
      expect(result.queuedInventory.total).toBe(1);
      expect(result.queuedInventory.sessions[0].session_id).toBe("unknown");
      const unknownObservation: OwnerObservation[] = [
        {
          session_id: "unknown",
          workspace_id: "w",
          state: "active",
          settlement: null,
          kind: "runnable",
        },
      ];
      expect(
        applyOwnership(result.queuedInventory, unknownObservation, false, true).unknownQueueAge,
      ).toBe(1);
      expect(result.empty).not.toHaveProperty("gap");
      expect(result.empty.sample).toBe(3);
      expect(result.empty.missingCompletionEvidence).toBe(2);
      expect(result.empty.repeatedSessions).toBe(0);
    },
    30000,
  );
});
