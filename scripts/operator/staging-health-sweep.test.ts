import { describe, expect, test } from "bun:test";
import {
  CONTROL_CTE,
  DATABASE_RUNNER,
  databaseQueries,
  errorComparison,
  memoryBytes,
  parseArgs,
  podFacts,
  sweep,
  textResult,
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
});
