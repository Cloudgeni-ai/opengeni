import postgres from "postgres";
import { createConnection, createServer } from "node:net";
import { tool } from "@openai/agents";
import { z } from "zod";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  resolveAcceptedConnectionUse,
  type AcceptedConnectionUseContext,
} from "@opengeni/db";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import {
  functionCall,
  MemoryEventBus,
  ScriptedModel,
  startTestServices,
  testSettings,
} from "@opengeni/testing";
import { createActivityTestHarness } from "../../apps/worker/src/activities";
import { submitTestHumanPrompt } from "../../test/integration/helpers/session-control";
import { postgresWireBudget } from "./postgres-wire-budget";

// Own disposable cluster: CHECKPOINT and cluster-wide MultiXact/SLRU counters
// must never run against a deployment or a shared test server. No provider calls.
const services = await startTestServices({ temporal: false });
const admin = postgres(services.databaseUrl, { max: 2, onnotice: () => undefined });
let budget: { statements: number; transactions: number; cycles: number } | undefined;
const upstream = new URL(services.runtimeDatabaseUrl);
const relay = createServer((frontend) => {
  const backend = createConnection({ host: upstream.hostname, port: Number(upstream.port) });
  frontend.on(
    "data",
    postgresWireBudget(() => {
      if (budget) budget.cycles++;
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
if (!address || typeof address === "string") throw new Error("No benchmark relay address");
const databaseUrl = new URL(services.runtimeDatabaseUrl);
databaseUrl.port = String(address.port);
const client = createDb(databaseUrl.href, { max: 16 });
const endpoint = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => Response.json({ result: "local connector result" }),
});
const settings = testSettings({ databaseUrl: services.runtimeDatabaseUrl, sandboxBackend: "none" });
const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
driver.options.debug = (_connection, query) => {
  if (!budget) return;
  budget.statements++;
  if (/^begin\b/iu.test(query)) budget.transactions++;
};

async function workspace() {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "benchmark",
    accountExternalId: id,
    accountName: "Connection benchmark",
    workspaceExternalSource: "benchmark",
    workspaceExternalId: id,
    workspaceName: "Connection benchmark",
    subjectId: `benchmark:${id}`,
  });
  const grant = access.workspaceGrants[0]!;
  const [connection] = await admin<{ id: string }[]>`insert into connections
    (account_id,workspace_id,origin_workspace_id,provider_domain,kind,credential_encrypted,status)
    values (${grant.accountId},${grant.workspaceId},${grant.workspaceId},'connector.example.test','api_key','unused-fixture-credential','active') returning id`;
  return { grant, connectionId: connection!.id };
}

async function sessionFor(grant: Awaited<ReturnType<typeof workspace>>["grant"]) {
  return createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Run five independent connector lookups",
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    resources: [],
    metadata: {},
  });
}

async function authorize(
  context: Omit<AcceptedConnectionUseContext, "physicalRequestId" | "usePhase">,
  connectionId: string,
  usePhase: "credential_resolution" | "provider_request",
) {
  const result = await resolveAcceptedConnectionUse(client.db, {
    ...context,
    physicalRequestId: crypto.randomUUID(),
    usePhase,
    serverId: "fixture",
    providerDomain: "connector.example.test",
    connectionId,
    connectionKind: "api_key",
    subjectScope: "workspace",
  });
  if (result.status !== "authorized")
    throw new Error(`Connection validation failed: ${JSON.stringify(result)}`);
}

async function validatorFixture() {
  const { grant, connectionId } = await workspace();
  const session = await sessionFor(grant);
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `benchmark:${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `benchmark:${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Fixture was not claimed");
  return {
    connectionId,
    context: {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    },
  };
}

async function fiveToolTurn() {
  const { grant, connectionId } = await workspace();
  const session = await sessionFor(grant);
  await submitTestHumanPrompt(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    subjectId: grant.subjectId,
    text: "Run five independent connector lookups",
    resources: [],
    tools: [],
    reasoningEffortFallback: "medium",
  });
  const model = new ScriptedModel([
    {
      output: Array.from({ length: 5 }, (_, item) =>
        functionCall("fixture_lookup", { item }, `fixture-call-${item}`),
      ),
    },
    { outputText: "All five lookups completed." },
  ]);
  const runtime = createProductionAgentRuntime({ model });
  runtime.generateSessionTitle = async () => ({ title: null, usage: null });
  const prepare = runtime.prepareTools;
  let context!: Omit<AcceptedConnectionUseContext, "physicalRequestId" | "usePhase">;
  runtime.prepareTools = (configuration, tools, options = {}) => {
    context = {
      accountId: options.accountId!,
      workspaceId: options.workspaceId!,
      sessionId: options.sessionId!,
      turnId: options.turnId!,
      attemptId: options.attemptId!,
      executionGeneration: options.executionGeneration!,
    };
    return prepare(configuration, tools, options);
  };
  const build = runtime.buildAgent;
  let active = 0,
    maxActive = 0,
    finished = 0;
  const toolMs: number[] = [];
  runtime.buildAgent = (configuration, resources, options) => {
    const agent = build(configuration, resources, options);
    // Same production runtime tool execution seam used by integration tests.
    // The connector is a local fixture, with both real DB authorization phases.
    agent.tools.push(
      tool({
        name: "fixture_lookup",
        description: "Read one independent fixture item",
        parameters: z.object({ item: z.number() }),
        execute: async ({ item }) => {
          const started = performance.now();
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            await authorize(context, connectionId, "credential_resolution");
            await authorize(context, connectionId, "provider_request");
            const response = await fetch(`http://127.0.0.1:${endpoint.port}/lookup/${item}`);
            if (!response.ok) throw new Error("Local connector failed");
            finished++;
            return await response.json();
          } finally {
            active--;
            toolMs.push(performance.now() - started);
          }
        },
      }),
    );
    return agent;
  };
  const activities = createActivityTestHarness({
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    runtime,
  });
  budget = { statements: 0, transactions: 0, cycles: 0 };
  const started = performance.now(),
    cpu = process.cpuUsage();
  try {
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
      workflowId: `benchmark:${session.id}`,
      workflowRunId: crypto.randomUUID(),
    });
    const used = process.cpuUsage(cpu);
    if (result.status !== "idle" || model.calls !== 2 || finished !== 5 || maxActive !== 5)
      throw new Error(
        `Turn did not run five parallel tools: ${JSON.stringify({ result, calls: model.calls, finished, maxActive })}`,
      );
    return {
      wallMs: performance.now() - started,
      cpuMs: (used.user + used.system) / 1000,
      ...budget,
      toolMs,
      maxActive,
      modelCalls: model.calls,
      modelToolHistory: Array.isArray(model.requests[1]?.input)
        ? model.requests[1].input.filter(
            (item) => item.type === "function_call" || item.type === "function_call_result",
          )
        : [],
    };
  } finally {
    budget = undefined;
  }
}

async function counters() {
  // SLRU statistics are backend-local until flushed. Reserve the complete
  // fixture pool so every participant publishes its counters before reading.
  const connections = await Promise.all(Array.from({ length: 16 }, () => driver.reserve()));
  try {
    await Promise.all(
      connections.map((connection) => connection`select pg_stat_force_next_flush()`),
    );
  } finally {
    for (const connection of connections) connection.release();
  }
  // Only this script's newly created cluster; excluded from all timing samples.
  await admin`checkpoint`;
  const [control] = await admin<{ nextMulti: string; nextMember: string; walLsn: string }[]>`
    select next_multixact_id::text::bigint as "nextMulti", next_multi_offset::text::bigint as "nextMember",
      pg_current_wal_insert_lsn()::text as "walLsn"
    from pg_control_checkpoint()`;
  const slru = await admin`select name,blks_zeroed,blks_hit,blks_read,blks_written,flushes,truncates
    from pg_stat_slru where name ilike 'multixact%' order by name`;
  if (!control || slru.length !== 2) throw new Error("MultiXact statistics unavailable");
  return {
    nextMulti: Number(control.nextMulti),
    nextMember: Number(control.nextMember),
    walLsn: control.walLsn,
    slru: Array.from(slru),
  };
}

async function sampled<T>(run: () => Promise<T>) {
  const state = { running: true };
  let samples = 0;
  const waitCounts: Record<string, number> = {};
  const observer = (async () => {
    while (state.running) {
      const rows = await admin<
        { wait: string; count: number }[]
      >`select wait_event as wait,count(*)::int as count
        from pg_stat_activity where datname=current_database() and wait_event ilike '%multixact%'
        group by wait_event`;
      samples++;
      for (const row of rows) waitCounts[row.wait] = (waitCounts[row.wait] ?? 0) + row.count;
      await Bun.sleep(10);
    }
  })();
  try {
    return { result: await run(), samples, waitCounts };
  } finally {
    state.running = false;
    await observer;
  }
}

const phases = [];
try {
  await services.migrate();
  const [versionRow] = await admin<{ version: string }[]>`select version() as version`;
  const [definitionRow] = await admin<{ definition: string }[]>`select pg_get_functiondef(
    'resolve_accepted_connection_use(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,uuid,text,text,text,text)'::regprocedure) as definition`;
  if (!versionRow || !definitionRow) throw new Error("Benchmark database metadata missing");
  const { version } = versionRow;
  const { definition: after } = definitionRow;
  // Reverse only this migration, on the private fixture, to compare identical
  // code/data/runtime versions. No historical authorization code is revived.
  let before = after.replace(
    "  PERFORM pg_advisory_xact_lock_shared(hashtextextended('workspace-control:' || p_workspace_id::text, 0));\n",
    "",
  );
  for (const [anchor, replacement] of [
    [
      "FOR SHARE;\n    IF NOT FOUND OR session_row.active_turn_id",
      "FOR NO KEY UPDATE;\n    IF NOT FOUND OR session_row.active_turn_id",
    ],
    [
      "AND turn_value.status = 'running'\n    FOR SHARE;",
      "AND turn_value.status = 'running'\n    FOR UPDATE;",
    ],
    [
      "IS NOT DISTINCT FROM session_row.owner_organization_membership_id\n    FOR SHARE;",
      "IS NOT DISTINCT FROM session_row.owner_organization_membership_id\n    FOR UPDATE;",
    ],
  ]) {
    if (before.split(anchor!).length !== 2) throw new Error("Benchmark resolver anchor changed");
    before = before.replace(anchor!, replacement!);
  }
  if (before === after || before.includes("pg_advisory_xact_lock_shared"))
    throw new Error("Invalid before fixture");
  // Repeat both directions to expose warmup/order effects rather than publish
  // the fastest one-off sample. The first two turns in each phase are warmups.
  const modes: Array<"before" | "after"> =
    process.env.OPENGENI_BENCH_TURN_ONLY === "1"
      ? ["after"]
      : ["before", "after", "before", "after"];
  for (const mode of modes) {
    await admin.unsafe(mode === "before" ? before : after);
    const fixture = await validatorFixture();
    const start = await counters();
    const validators = await sampled(async () => {
      const batches = [];
      for (let i = 0; i < (process.env.OPENGENI_BENCH_TURN_ONLY === "1" ? 0 : 100); i++) {
        const began = performance.now();
        await Promise.all(
          Array.from({ length: 5 }, () =>
            authorize(fixture.context, fixture.connectionId, "credential_resolution"),
          ),
        );
        batches.push(performance.now() - began);
      }
      return batches;
    });
    const middle = await counters();
    const turns = await sampled(async () => {
      const results = [];
      for (let i = 0; i < Number(process.env.OPENGENI_BENCH_TURN_SAMPLES ?? "8"); i++)
        results.push(await fiveToolTurn());
      return results;
    });
    const end = await counters();
    const phase = { mode, start, middle, end, validators, turns };
    phases.push(phase);
    console.log(
      JSON.stringify({
        mode,
        validatorMultiXacts: middle.nextMulti - start.nextMulti,
        validatorMembers: middle.nextMember - start.nextMember,
        slruWaits: validators.waitCounts,
        turnMs: turns.result.map((turn) => turn.wallMs),
        maxToolConcurrency: turns.result.map((turn) => turn.maxActive),
      }),
    );
  }
  const output = {
    generatedAt: new Date().toISOString(),
    version,
    phases,
    limitations:
      "Local real PostgreSQL and production worker/runtime; scripted model, local connector HTTP fixture, in-memory event bus; no Temporal persistence or external provider latency. Cluster counters include fixture setup in the turn phase. CHECKPOINT is outside timings. Wait events sampled every 10ms, not exhaustive.",
    cycleDefinition:
      "Frontend PostgreSQL Q/H/S synchronization messages, not TCP packets or sequential network latency. Warm samples exclude prepared-statement setup effects.",
  };
  if (process.env.OPENGENI_BENCH_OUTPUT)
    await Bun.write(process.env.OPENGENI_BENCH_OUTPUT, JSON.stringify(output, null, 2));
} finally {
  endpoint.stop(true);
  await client.close();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await admin.end();
  await services.down();
}
process.exit(0);
