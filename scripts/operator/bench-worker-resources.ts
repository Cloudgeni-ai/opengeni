import { AsyncLocalStorage } from "node:async_hooks";
import { createConnection, createServer } from "node:net";
import type postgres from "postgres";
import { bootstrapWorkspace, createDb, createSession, type Database } from "@opengeni/db";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  ScriptedModel,
  testSettings,
} from "@opengeni/testing";
import { createActivityTestHarness } from "../../apps/worker/src/activities";
import { submitTestHumanPrompt } from "../../test/integration/helpers/session-control";
import { postgresWireBudget } from "./postgres-wire-budget";

// Real restricted-role PostgreSQL and production activity/runtime code. The
// model and event bus are in-process fixtures; this excludes Temporal DB cost.
type Sample = {
  operation: string;
  statements: number;
  transactions: number;
  cycles: number;
  ms: number;
  cpuMs: number;
  queries: Record<string, number>;
  scopeStatements: Record<string, number>;
};
const samples: Sample[] = [];
const scope = new AsyncLocalStorage<Sample>();
const transactionOrigin = new AsyncLocalStorage<string>();
const instrumented = new WeakSet<object>();
function instrumentTransactions(db: Database): void {
  if (instrumented.has(db)) return;
  instrumented.add(db);
  const original = db.transaction.bind(db);
  db.transaction = ((callback, config) => {
    const stack = new Error().stack?.split("\n").slice(2).join("\n") ?? "unknown";
    return transactionOrigin.run(stack, () =>
      original(async (tx) => {
        instrumentTransactions(tx as unknown as Database);
        return await callback(tx);
      }, config),
    );
  }) as Database["transaction"];
}
let current: Sample | undefined;
const shared = await acquireSharedTestDatabase("worker-resource-benchmark");
if (!shared) throw new Error("Local PostgreSQL required");
const upstream = new URL(shared.appUrl);
const relay = createServer((frontend) => {
  const backend = createConnection({ host: upstream.hostname, port: Number(upstream.port) });
  frontend.on(
    "data",
    postgresWireBudget(() => {
      if (current) current.cycles++;
    }),
  );
  frontend.pipe(backend);
  backend.pipe(frontend);
  const close = () => {
    frontend.destroy();
    backend.destroy();
  };
  frontend.on("error", close);
  frontend.on("close", close);
  backend.on("error", close);
  backend.on("close", close);
});
await new Promise<void>((resolve, reject) => {
  relay.once("error", reject);
  relay.listen(0, "127.0.0.1", resolve);
});
const address = relay.address();
if (!address || typeof address === "string") throw new Error("No relay address");
const url = new URL(shared.appUrl);
url.port = String(address.port);
const client = createDb(url.href);
if (process.env.OPENGENI_BENCH_SCOPE_STACKS === "1") instrumentTransactions(client.db);
const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
driver.options.debug = (_id, query) => {
  const sample = scope.getStore();
  if (!sample) return;
  sample.statements++;
  if (/^begin/i.test(query.trim())) sample.transactions++;
  const key = query.replace(/\s+/gu, " ").slice(0, 250);
  sample.queries[key] = (sample.queries[key] ?? 0) + 1;
  const origin = transactionOrigin.getStore();
  if (origin) sample.scopeStatements[origin] = (sample.scopeStatements[origin] ?? 0) + 1;
};
const measure = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
  const sample: Sample = {
    operation,
    statements: 0,
    transactions: 0,
    cycles: 0,
    ms: 0,
    cpuMs: 0,
    queries: {},
    scopeStatements: {},
  };
  current = sample;
  const started = performance.now(),
    cpu = process.cpuUsage();
  try {
    return await scope.run(sample, run);
  } finally {
    sample.ms = performance.now() - started;
    const used = process.cpuUsage(cpu);
    sample.cpuMs = (used.user + used.system) / 1000;
    current = undefined;
    samples.push(sample);
  }
};
try {
  for (let index = 0; index < Number(process.env.OPENGENI_BENCH_WORKER_SAMPLES ?? "5"); index++) {
    const id = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "benchmark",
      accountExternalId: id,
      accountName: "Worker benchmark",
      workspaceExternalSource: "benchmark",
      workspaceExternalId: id,
      workspaceName: "Worker benchmark",
      subjectId: `benchmark:${id}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Count a scripted turn",
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      resources: [],
      metadata: {},
    });
    await submitTestHumanPrompt(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      text: "Count a scripted turn",
      resources: [],
      tools: [],
      reasoningEffortFallback: "medium",
    });
    const model = new ScriptedModel([
      {
        outputText: "Hello from a scripted turn.",
        chunks: ["Hello ", "from ", "a scripted turn."],
      },
    ]);
    const runtime = createProductionAgentRuntime({ model });
    runtime.generateSessionTitle = async () => ({ title: null, usage: null });
    const activities = createActivityTestHarness({
      settings: testSettings({ databaseUrl: url.href, sandboxBackend: "none" }),
      db: client.db,
      bus: new MemoryEventBus(),
      runtime,
    });
    const result = await measure("scripted-turn", () =>
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        attemptId: crypto.randomUUID(),
        trigger: { kind: "next" },
        workflowId: `benchmark:${id}`,
        workflowRunId: crypto.randomUUID(),
      }),
    );
    if (result.status !== "idle" || model.calls !== 1)
      throw new Error(`Unexpected turn result: ${JSON.stringify(result)}, calls=${model.calls}`);
    for (let idle = 0; idle < 3; idle++) {
      await measure("idle-peek", () =>
        activities.peekSessionWork({
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          observerAccountId: grant.accountId,
          includeAdmissionFence: true,
          includeDeletion: true,
        }),
      );
    }
  }
  const output = { generatedAt: new Date().toISOString(), memory: process.memoryUsage(), samples };
  if (process.env.OPENGENI_BENCH_OUTPUT)
    await Bun.write(process.env.OPENGENI_BENCH_OUTPUT, JSON.stringify(output, null, 2));
  console.log(
    JSON.stringify(
      samples.map(({ queries: _queries, scopeStatements: _scopeStatements, ...sample }) => sample),
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await shared.release();
}
process.exit(0);
