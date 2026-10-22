import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { readSkillCatalogContext, skillCatalogContextItem } from "@opengeni/contracts";
import {
  createDb,
  bootstrapWorkspace,
  createSession,
  withWorkspaceSubjectSessionActivityRls,
  submitHumanPromptInTransaction,
  claimSessionWorkForAttempt,
  ensureSessionSkillCatalog,
  getActiveSessionHistoryItems,
  applySessionTurnSettlement,
  applyContextCompaction,
  requestSessionCompaction,
  appendSessionHistoryItems,
  sessionHasToolRouterHistory,
  sessionsWithToolRouterHistory,
  withWorkspaceRls,
} from "../src/index";
import { toolRouterHistoryProbe } from "../src/session-tool-router-history";
import { sql, type SQL } from "drizzle-orm";
import type postgres from "postgres";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("skill-catalog-context");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "skills",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "skills",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  async function claim(maintenance = false) {
    if (maintenance) await requestSessionCompaction(client.db, workspaceId, session.id);
    else
      await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
        submitHumanPromptInTransaction(db, {
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "work",
          resources: [],
          reasoningEffort: "low",
          reasoningEffortFallback: "low",
          source: "user",
        }),
      );
    const result = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (result.action !== "claimed") throw new Error("not claimed");
    return result.turn;
  }
  const identity = (turn: Awaited<ReturnType<typeof claim>>) => ({
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: turn.id,
    expectedExecutionGeneration: turn.executionGeneration,
    expectedAttemptId: turn.activeAttemptId!,
  });
  const settle = (turn: Awaited<ReturnType<typeof claim>>) =>
    applySessionTurnSettlement(client.db, workspaceId, {
      sessionId: session.id,
      turnId: turn.id,
      triggerEventId: turn.triggerEventId,
      attemptId: turn.activeAttemptId!,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: {} }],
    });
  const history = () => getActiveSessionHistoryItems(client.db, workspaceId, session.id);
  const install = (turn: Awaited<ReturnType<typeof claim>>, catalog: string) =>
    ensureSessionSkillCatalog(client.db, { ...identity(turn), catalog });
  return {
    claim,
    identity,
    settle,
    history,
    install,
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
  };
}

test("router protocol history remains visible after compaction and is session-scoped", async () => {
  const f = await fixture();
  const other = await fixture();
  const turn = await f.claim();
  const scope = { accountId: f.accountId, workspaceId: f.workspaceId, sessionId: f.sessionId };
  expect(await sessionHasToolRouterHistory(client.db, scope)).toBe(false);
  expect(
    await appendSessionHistoryItems(client.db, {
      ...f.identity(turn),
      items: [
        {
          position: 100,
          item: {
            type: "function_call",
            name: "tool_list",
            call_id: "router-call",
            arguments: "{}",
          },
        },
      ],
    }),
  ).toBe(true);
  expect(await sessionHasToolRouterHistory(client.db, scope)).toBe(true);
  expect(
    await sessionsWithToolRouterHistory(client.db, {
      ...scope,
      sessionIds: [f.sessionId, f.sessionId, other.sessionId, crypto.randomUUID()],
    }),
  ).toEqual(new Set([f.sessionId]));
  expect(
    (
      await applyContextCompaction(client.db, {
        ...f.identity(turn),
        replacementItems: [],
        summaryItem: { type: "compaction", encrypted_content: "router-history" },
      })
    ).applied,
  ).toBe(true);
  expect(await sessionHasToolRouterHistory(client.db, scope)).toBe(true);
  expect(
    await sessionsWithToolRouterHistory(client.db, {
      ...scope,
      sessionIds: [f.sessionId],
    }),
  ).toEqual(new Set([f.sessionId]));
  expect(
    await sessionsWithToolRouterHistory(client.db, {
      accountId: other.accountId,
      workspaceId: other.workspaceId,
      sessionIds: [f.sessionId],
    }),
  ).toEqual(new Set());
  expect(
    await sessionHasToolRouterHistory(client.db, {
      accountId: other.accountId,
      workspaceId: other.workspaceId,
      sessionId: other.sessionId,
    }),
  ).toBe(false);
}, 180_000);

test("the router probe is a partial-index lookup that never visits ordinary history", async () => {
  const f = await fixture();
  const turn = await f.claim();
  expect(
    await appendSessionHistoryItems(client.db, {
      ...f.identity(turn),
      items: Array.from({ length: 200 }, (_, index) => ({
        position: 100 + index,
        item: { type: "function_call", name: "exec_command", call_id: `ordinary-${index}` },
      })),
    }),
  ).toBe(true);
  await shared.admin`analyze session_history_items`;
  type PlanNode = { "Index Name"?: string; "Node Type": string; Plans?: PlanNode[] };
  const indexes: string[] = [];
  await withWorkspaceRls(client.db, f.workspaceId, async (tx) => {
    const query = toolRouterHistoryProbe(tx, f).toSQL();
    const fragments: SQL[] = query.sql
      .split(/\$(\d+)/g)
      .map((part, index) =>
        index % 2 === 0 ? sql.raw(part) : sql`${query.params[Number(part) - 1]}`,
      );
    const result = await tx.execute(sql`explain (format json) ${sql.join(fragments, sql``)}`);
    const plans = result[0]?.["QUERY PLAN"] as { Plan: PlanNode }[] | undefined;
    const plan = plans?.[0]?.Plan;
    if (!plan) throw new Error("Skill catalog probe returned no execution plan");
    const walk = (node: PlanNode) => {
      if (node["Index Name"]) indexes.push(node["Index Name"]);
      node.Plans?.forEach(walk);
    };
    walk(plan);
  });
  expect(indexes).toContain("session_history_items_tool_router_idx");
  expect(
    await sessionHasToolRouterHistory(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
    }),
  ).toBe(false);
}, 180_000);

test("response pages batch keyed router probes in one transaction with bounded history reads", async () => {
  const f = await fixture();
  const turn = await f.claim();
  expect(
    await appendSessionHistoryItems(client.db, {
      ...f.identity(turn),
      items: Array.from({ length: 1000 }, (_, index) => ({
        position: 100 + index,
        item: {
          type: "function_call",
          name: "tool_list",
          call_id: `router-${index}`,
          arguments: "{}",
        },
      })),
    }),
  ).toBe(true);
  const sessionIds = [f.sessionId];
  for (let index = 1; index < 50; index++) {
    const session = await createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    sessionIds.push(session.id);
  }
  const input = { accountId: f.accountId, workspaceId: f.workspaceId, sessionIds };
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const originalDebug = driver.options.debug;
  let statements = 0;
  let transactions = 0;
  let batchQuery: { text: string; params: unknown[] } | undefined;
  const measurements: {
    operation: string;
    statements: number;
    transactions: number;
    ms: number;
  }[] = [];
  const measure = async (operation: string, run: () => Promise<Set<string>>) => {
    statements = 0;
    transactions = 0;
    const start = performance.now();
    expect(await run()).toEqual(new Set([f.sessionId]));
    measurements.push({ operation, statements, transactions, ms: performance.now() - start });
  };
  try {
    driver.options.debug = (_connection, query, params) => {
      statements++;
      if (/^begin/i.test(query.trim())) transactions++;
      if (query.includes("cross join lateral") && query.includes("requested.session_id")) {
        batchQuery = { text: query, params: [...params] };
      }
    };
    for (let index = 0; index < 3; index++) {
      await measure("individual", async () => {
        const rows = await Promise.all(
          sessionIds.map(
            async (sessionId) =>
              [
                sessionId,
                await sessionHasToolRouterHistory(client.db, { ...input, sessionId }),
              ] as const,
          ),
        );
        return new Set(rows.filter(([, present]) => present).map(([id]) => id));
      });
      await measure("batch", () => sessionsWithToolRouterHistory(client.db, input));
    }
    statements = 0;
    expect(await sessionsWithToolRouterHistory(client.db, { ...input, sessionIds: [] })).toEqual(
      new Set(),
    );
    expect(statements).toBe(0);
  } finally {
    driver.options.debug = originalDebug;
  }
  for (const row of measurements) {
    expect(row.transactions).toBe(row.operation === "batch" ? 1 : 50);
    // The first single reads may also describe driver types on new connections.
    if (row.operation === "batch") expect(row.statements).toBe(4);
  }
  if (process.env.OPENGENI_BENCH_ROUTER_HISTORY === "1")
    console.log(JSON.stringify({ routerHistory: measurements }));
  if (!batchQuery) throw new Error("No batch query captured");
  await shared.admin`analyze session_history_items`;
  const query = batchQuery;
  for (const bitmapScan of [true, false]) {
    await withWorkspaceRls(client.db, f.workspaceId, async (tx) => {
      if (!bitmapScan) await tx.execute(sql`set local enable_bitmapscan = off`);
      const fragments = query.text
        .split(/\$(\d+)/g)
        .map((part, index) =>
          index % 2 === 0 ? sql.raw(part) : sql`${sql.param(query.params[Number(part) - 1])}`,
        );
      const rows = await tx.execute(
        sql`explain (analyze, format json) ${sql.join(fragments, sql``)}`,
      );
      type Node = {
        "Node Type": string;
        "Index Name"?: string;
        "Index Cond"?: string;
        "Relation Name"?: string;
        "Actual Rows": number;
        "Actual Loops": number;
        "Rows Removed by Filter"?: number;
        "Rows Removed by Index Recheck"?: number;
        "Exact Heap Blocks"?: number;
        "Lossy Heap Blocks"?: number;
        Plans?: Node[];
      };
      const plans = rows[0]?.["QUERY PLAN"] as { Plan: Node }[] | undefined;
      const plan = plans?.[0]?.Plan;
      if (!plan) throw new Error("No batch router-history plan returned");
      if (process.env.OPENGENI_BENCH_ROUTER_HISTORY === "1")
        console.log(JSON.stringify({ bitmapScan, routerHistoryPlan: plan }));
      const probes: Node[] = [];
      const historyReads: Node[] = [];
      const visit = (node: Node) => {
        if (node["Index Name"] === "session_history_items_tool_router_idx") probes.push(node);
        if (node["Relation Name"] === "session_history_items") historyReads.push(node);
        node.Plans?.forEach(visit);
      };
      visit(plan);
      expect(probes.length).toBeGreaterThan(0);
      for (const probe of probes) {
        expect(probe["Index Cond"]).toContain("workspace_id =");
        expect(probe["Index Cond"]).toContain("session_id = requested.session_id");
      }
      // LIMIT stops heap reads, not bitmap construction: a valid bitmap index
      // scan can collect every matching router TID before fetching its first row.
      // Assert the actual history reads and keyed partial-index access separately.
      expect(historyReads.length).toBeGreaterThan(0);
      for (const read of historyReads) expect(read["Node Type"]).not.toBe("Seq Scan");
      expect(
        historyReads.reduce(
          (sum, node) =>
            sum +
            (node["Actual Rows"] +
              (node["Rows Removed by Filter"] ?? 0) +
              (node["Rows Removed by Index Recheck"] ?? 0)) *
              node["Actual Loops"],
          0,
        ),
      ).toBeLessThanOrEqual(50);
      // EXPLAIN rounds per-loop row counts; exact heap blocks are an additional
      // check that catches a bitmap heap scan traversing retained history.
      expect(
        historyReads.reduce((sum, node) => sum + (node["Exact Heap Blocks"] ?? 0), 0),
      ).toBeLessThanOrEqual(50);
      expect(historyReads.some((node) => (node["Lossy Heap Blocks"] ?? 0) > 0)).toBe(false);
    });
  }
}, 180_000);

test("catalog changes append without rewriting history; unchanged turns and retries freeze the same snapshot", async () => {
  const f = await fixture();
  const first = await f.claim();
  expect(await f.install(first, "A")).toBe("A");
  const original = await f.history();
  expect(readSkillCatalogContext(original[0]!.item)).toBe("A");
  expect(original[1]!.item.role).toBe("user");
  expect(await f.install(first, "changed during retry")).toBe("A");
  expect(await f.history()).toEqual(original);
  await f.settle(first);
  const second = await f.claim();
  expect(await f.install(second, "A")).toBe("A");
  // Even without a newly appended catalog, this logical turn's choice is frozen.
  expect(await f.install(second, "changed during retry")).toBe("A");
  const unchanged = await f.history();
  expect(unchanged.filter((row) => readSkillCatalogContext(row.item) !== null)).toHaveLength(1);
  expect(unchanged.slice(0, original.length)).toEqual(original);
  await f.settle(second);
  const third = await f.claim();
  expect(await f.install(third, "B")).toBe("B");
  const updated = await f.history();
  expect(updated.slice(0, unchanged.length)).toEqual(unchanged);
  expect(readSkillCatalogContext(updated.at(-2)!.item)).toBe("B");
  expect(updated.at(-1)!.item.role).toBe("user");
  await expect(f.install(first, "stale")).rejects.toThrow("fenced");
  const compacted = await applyContextCompaction(client.db, {
    ...f.identity(third),
    replacementItems: [skillCatalogContextItem("B")],
    summaryItem: { type: "compaction", encrypted_content: "test" },
  });
  expect(compacted.applied).toBe(true);
  // Receipt still resolves the original row even after it became inactive.
  expect(await f.install(third, "C")).toBe("B");
  expect(await f.history()).toHaveLength(2);
  await f.settle(third);
  const fourth = await f.claim();
  expect(await f.install(fourth, "B")).toBe("B");
  expect(
    (await f.history()).filter((row) => readSkillCatalogContext(row.item) !== null),
  ).toHaveLength(1);
}, 180_000);

test("maintenance installs a catalog without inventing user input", async () => {
  const f = await fixture();
  const turn = await f.claim(true);
  expect(await f.install(turn, "No Skills available")).toBe("No Skills available");
  expect(await f.install(turn, "retry change")).toBe("No Skills available");
  const history = await f.history();
  expect(history).toHaveLength(1);
  expect(history[0]!.item.role).toBe("developer");
}, 180_000);
