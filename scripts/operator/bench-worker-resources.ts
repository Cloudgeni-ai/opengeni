import { AsyncLocalStorage } from "node:async_hooks";
import { createConnection, createServer } from "node:net";
import type postgres from "postgres";
import { tool } from "@openai/agents";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getActiveSessionHistoryItemsPaged,
  type Database,
} from "@opengeni/db";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { ScriptedModel, functionCall } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import { createActivityTestHarness } from "../../apps/worker/src/activities";
import { submitTestHumanPrompt } from "../../test/integration/helpers/session-control";
import { postgresWireBudget } from "./postgres-wire-budget";

// Real restricted-role PostgreSQL and production activity/runtime code. The
// model and event bus are in-process fixtures; this excludes Temporal DB cost.
// OPENGENI_BENCH_WORKER_TOOLS=5 adds five local SDK tool calls and a second
// model response. It measures durable tool checkpoints, not connector dispatch
// or external execution. Cycles are protocol boundaries, not serial latency.
type Sample = {
  operation: string;
  statements: number;
  transactions: number;
  cycles: number;
  responseBytes: number;
  ms: number;
  cpuMs: number;
  queries: Record<string, number>;
  scopeStatements: Record<string, number>;
};
const samples: Sample[] = [];
const toolCount = Number(process.env.OPENGENI_BENCH_WORKER_TOOLS ?? "0");
if (toolCount !== 0 && toolCount !== 5) throw new Error("Worker fixture supports 0 or 5 tools");
const streamChunks = Number(process.env.OPENGENI_BENCH_STREAM_CHUNKS ?? "0");
const streamDelayMs = Number(process.env.OPENGENI_BENCH_STREAM_DELAY_MS ?? "0");
if (
  !Number.isInteger(streamChunks) ||
  streamChunks < 0 ||
  streamChunks > 10_000 ||
  !Number.isInteger(streamDelayMs) ||
  streamDelayMs < 0 ||
  streamDelayMs > 1_000
)
  throw new Error("Invalid scripted stream fixture");
const responseChunks = streamChunks
  ? Array.from({ length: streamChunks }, (_, index) => `part-${index} `)
  : ["Hello ", "from ", "a scripted turn."];
const responseText = responseChunks.join("");
const streamRows: number[] = [];
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
  backend.on("data", (chunk: Buffer) => {
    if (current) current.responseBytes += chunk.length;
  });
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
  // Queued pool work can inherit a previous operation's async context. Only
  // one measured operation runs at a time, so use the same owner as the wire.
  const sample = current;
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
    responseBytes: 0,
    ms: 0,
    cpuMs: 0,
    queries: {},
    scopeStatements: {},
  };
  current = sample;
  const started = performance.now(),
    cpu = process.cpuUsage();
  try {
    return await run();
  } finally {
    sample.ms = performance.now() - started;
    const used = process.cpuUsage(cpu);
    sample.cpuMs = (used.user + used.system) / 1000;
    current = undefined;
    samples.push(sample);
  }
};
try {
  // Production initializes its service graph once per process. Rebuilding it
  // for every sample would charge startup heap inspection and catalog loading
  // to each turn. Only the first sample below includes lazy service startup.
  const model = new ScriptedModel([]);
  const runtime = createProductionAgentRuntime({ model });
  let executedTools = 0;
  if (toolCount) {
    const buildAgent = runtime.buildAgent.bind(runtime);
    runtime.buildAgent = (...args) => {
      const agent = buildAgent(...args);
      agent.tools.push(
        tool({
          name: "local_fixture",
          description: "Offline benchmark no-op",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
          execute: async () => {
            executedTools++;
            return "local result";
          },
        }),
      );
      return agent;
    };
  }
  runtime.generateSessionTitle = async () => ({ title: null, usage: null });
  const activities = createActivityTestHarness({
    settings: testSettings({ databaseUrl: url.href, sandboxBackend: "none" }),
    db: client.db,
    bus: new MemoryEventBus(),
    runtime,
  });
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
    model.steps.push(
      ...(toolCount
        ? [
            {
              output: Array.from({ length: toolCount }, (_, i) =>
                functionCall("local_fixture", {}, `call-${i}`),
              ),
            },
          ]
        : []),
      {
        outputText: responseText,
        chunks: responseChunks,
        delayMs: streamDelayMs,
      },
    );
    const priorModelCalls = model.calls;
    const priorToolCalls = executedTools;
    const result = await measure(toolCount ? "five-tool-turn" : "scripted-turn", () =>
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
    if (
      result.status !== "idle" ||
      model.calls - priorModelCalls !== (toolCount ? 2 : 1) ||
      executedTools - priorToolCalls !== toolCount
    )
      throw new Error(
        `Unexpected turn result: ${JSON.stringify(result)}, calls=${model.calls}, tools=${executedTools}`,
      );
    if (toolCount) {
      // Verify persistence outside the measured operation, not just invocation.
      const history = await getActiveSessionHistoryItemsPaged(
        client.db,
        grant.workspaceId,
        session.id,
      );
      const callIds = (type: string) =>
        history
          .filter((row) => row.item.type === type)
          .map((row) => (row.item as { callId?: string }).callId)
          .sort();
      const expected = Array.from({ length: toolCount }, (_, i) => `call-${i}`);
      for (const type of ["function_call", "function_call_result"]) {
        if (JSON.stringify(callIds(type)) !== JSON.stringify(expected)) {
          throw new Error(`Missing durable ${type} rows`);
        }
      }
    }
    if (streamChunks) {
      const rows = await shared.admin<{ text: string }[]>`
        select payload->>'text' as text from session_events
        where workspace_id=${grant.workspaceId} and session_id=${session.id}
          and type='agent.message.delta' order by sequence`;
      if (rows.map((row) => row.text).join("") !== responseText)
        throw new Error("Durable streamed text differs from scripted provider output");
      streamRows.push(rows.length);
      const history = await getActiveSessionHistoryItemsPaged(
        client.db,
        grant.workspaceId,
        session.id,
      );
      const text = history
        .flatMap(({ item }) =>
          item.type === "message" && item.role === "assistant"
            ? item.content.flatMap((content) =>
                content.type === "output_text" ? [content.text] : [],
              )
            : [],
        )
        .join("");
      if (text !== responseText)
        throw new Error("Durable model history differs from scripted output");
    }
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
    // The scripted model keeps requests for assertions in tests. This harness
    // verifies durability instead; do not retain every sample's model input.
    model.requests.length = 0;
  }
  const output = {
    generatedAt: new Date().toISOString(),
    fixture: {
      toolCount,
      streamChunks,
      streamDelayMs,
      serviceLifetime: "process",
      firstTurnIncludesStartup: true,
    },
    streamRows,
    memory: process.memoryUsage(),
    samples,
  };
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
