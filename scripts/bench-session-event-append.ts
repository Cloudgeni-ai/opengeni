#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appendSessionEventsForTurnAttempt,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
} from "@opengeni/db";
import { acquireSharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

type EventClass = "raw" | "semantic";
type Topology = "same_session" | "same_workspace" | "multi_workspace";
type BenchmarkDb = Parameters<typeof appendSessionEventsForTurnAttempt>[0];
type RunningSession = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  executionGeneration: number;
  attemptId: string;
};

export type Distribution = {
  samples: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

type ScenarioReceipt = {
  name: string;
  topology: Topology;
  eventClass: EventClass;
  batchSize: number;
  concurrency: number;
  latencyMs: Distribution;
  throughputPerSecond: number;
};

const batchSizes = integerListArgument("--batch-sizes", [1, 10, 50]);
const concurrencies = integerListArgument("--concurrency", [1, 4, 8]);
const workspaceCount = integerArgument("--workspaces", 2);
const sessionCount = integerArgument(
  "--sessions",
  Math.max(16, Math.max(...concurrencies) * workspaceCount),
);
const sampleCount = integerArgument("--samples", 30);
const outputPath = resolve(
  stringArgument("--output") ??
    `${process.env.OPENGENI_EVIDENCE_DIR ?? "/tmp"}/session-event-append-benchmark.json`,
);

if (sessionCount < Math.max(...concurrencies) * workspaceCount || sessionCount > 1_000) {
  throw new Error(
    "--sessions must cover maximum concurrency in every workspace and be at most 1000",
  );
}
if (workspaceCount < 2 || workspaceCount > 10) {
  throw new Error("--workspaces must be between 2 and 10 so tenancy isolation is exercised");
}
if (sampleCount < 10 || sampleCount > 10_000) {
  throw new Error("--samples must be between 10 and 10000");
}
if (batchSizes.some((value) => value < 1 || value > 50)) {
  throw new Error("--batch-sizes values must be between 1 and 50");
}
if (concurrencies.some((value) => value < 1 || value > 64)) {
  throw new Error("--concurrency values must be between 1 and 64");
}

if (import.meta.main) {
  await main();
}

async function main(): Promise<void> {
  const shared = await acquireSharedTestDatabase("session_event_append_benchmark");
  if (!shared) {
    throw new Error("PostgreSQL is unavailable for the session-event append benchmark");
  }
  const client = createDb(shared.appUrl, { max: Math.max(...concurrencies) + 2 });
  const appSql = postgres(shared.appUrl, {
    max: Math.max(...concurrencies) + 2,
    prepare: false,
  });
  try {
    const posture = await databasePosture(shared.admin, appSql);
    const sessions = await seedSessions(client.db, sessionCount, workspaceCount);
    const firstWorkspaceSessions = sessions.filter(
      (session) => session.workspaceId === sessions[0]?.workspaceId,
    );
    const multiWorkspaceSessions = interleaveSessionsByWorkspace(sessions);
    await assertCrossTenantIsolation(appSql, sessions);
    for (const fixture of sessions) {
      await appendBatch(client.db, fixture, "raw", 1, "warmup");
      await appendBatch(client.db, fixture, "semantic", 1, "warmup");
    }

    const scenarios: ScenarioReceipt[] = [];
    for (const eventClass of ["raw", "semantic"] as const) {
      for (const batchSize of batchSizes) {
        scenarios.push(
          await runScenario({
            name: `same_session_${eventClass}_${batchSize}`,
            topology: "same_session",
            eventClass,
            batchSize,
            concurrency: 1,
            sampleCount,
            sessions: [sessions[0]!],
            db: client.db,
          }),
        );
        for (const concurrency of concurrencies) {
          scenarios.push(
            await runScenario({
              name: `same_workspace_${eventClass}_${batchSize}_c${concurrency}`,
              topology: "same_workspace",
              eventClass,
              batchSize,
              concurrency,
              sampleCount,
              sessions: firstWorkspaceSessions,
              db: client.db,
            }),
          );
          scenarios.push(
            await runScenario({
              name: `multi_workspace_${eventClass}_${batchSize}_c${concurrency}`,
              topology: "multi_workspace",
              eventClass,
              batchSize,
              concurrency,
              sampleCount,
              sessions: multiWorkspaceSessions,
              db: client.db,
            }),
          );
        }
      }
    }

    const invariantAudit = await durableInvariantAudit(shared.admin, sessions);
    const scaling = scalingReceipts(scenarios, Math.max(...concurrencies));
    const thresholds = {
      rawP95Ms: numberEnvironment("OPENGENI_BENCH_EVENT_APPEND_RAW_P95_MS", 75),
      semanticP95Ms: numberEnvironment("OPENGENI_BENCH_EVENT_APPEND_SEMANTIC_P95_MS", 125),
      minimumScalingEfficiency: numberEnvironment(
        "OPENGENI_BENCH_EVENT_APPEND_MIN_SCALING_EFFICIENCY",
        0.9,
      ),
    };
    const failures = evaluateFailures(scenarios, scaling, invariantAudit, thresholds);
    const receipt = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runtime: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
        gitSha: process.env.GITHUB_SHA ?? process.env.OPENGENI_BENCH_GIT_SHA ?? null,
      },
      configuration: {
        sessionCount,
        workspaceCount,
        sampleCount,
        batchSizes,
        concurrencies,
      },
      posture,
      scenarios,
      scaling,
      invariantAudit,
      thresholds,
      failures,
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ outputPath, scenarioCount: scenarios.length, thresholds, failures })}\n`,
    );
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await appSql.end().catch(() => undefined);
    await client.close().catch(() => undefined);
    await shared.release();
  }
}

async function databasePosture(
  admin: postgres.Sql,
  appSql: postgres.Sql,
): Promise<{
  postgresVersion: string;
  pgvectorVersion: string;
  fsync: string;
  synchronousCommit: string;
  fullPageWrites: string;
  appRole: string;
  appRoleSuperuser: boolean;
  appRoleBypassRls: boolean;
  sessionsForceRls: boolean;
  sessionEventCursorsForceRls: boolean;
  sessionEventsForceRls: boolean;
}> {
  const [role] = await appSql<
    { role: string; superuser: boolean; bypassRls: boolean }[]
  >`select current_user as role, rolsuper as superuser, rolbypassrls as "bypassRls"
    from pg_roles where rolname = current_user`;
  const relations = await admin<
    { relation: string; forceRls: boolean }[]
  >`select relname as relation, relforcerowsecurity as "forceRls"
    from pg_class where relname in ('sessions', 'session_event_cursors', 'session_events')`;
  const [server] = await admin<
    {
      postgresVersion: string;
      pgvectorVersion: string;
      fsync: string;
      synchronousCommit: string;
      fullPageWrites: string;
    }[]
  >`select
      current_setting('server_version') as "postgresVersion",
      (select extversion from pg_extension where extname = 'vector') as "pgvectorVersion",
      current_setting('fsync') as fsync,
      current_setting('synchronous_commit') as "synchronousCommit",
      current_setting('full_page_writes') as "fullPageWrites"`;
  const forceRls = new Map(relations.map((row) => [row.relation, row.forceRls]));
  if (
    !role ||
    !server?.pgvectorVersion ||
    server.fsync !== "on" ||
    server.synchronousCommit !== "on" ||
    server.fullPageWrites !== "on" ||
    role.superuser ||
    role.bypassRls ||
    !forceRls.get("sessions") ||
    !forceRls.get("session_event_cursors") ||
    !forceRls.get("session_events")
  ) {
    throw new Error(
      "Benchmark database does not enforce the production FORCE-RLS app-role posture",
    );
  }
  return {
    postgresVersion: server.postgresVersion,
    pgvectorVersion: server.pgvectorVersion,
    fsync: server.fsync,
    synchronousCommit: server.synchronousCommit,
    fullPageWrites: server.fullPageWrites,
    appRole: role.role,
    appRoleSuperuser: role.superuser,
    appRoleBypassRls: role.bypassRls,
    sessionsForceRls: forceRls.get("sessions") ?? false,
    sessionEventCursorsForceRls: forceRls.get("session_event_cursors") ?? false,
    sessionEventsForceRls: forceRls.get("session_events") ?? false,
  };
}

async function seedSessions(
  db: Parameters<typeof bootstrapWorkspace>[0],
  total: number,
  workspaces: number,
): Promise<RunningSession[]> {
  const fixtures: RunningSession[] = [];
  for (let workspaceIndex = 0; workspaceIndex < workspaces; workspaceIndex += 1) {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(db, {
      accountExternalSource: "session-event-append-benchmark",
      accountExternalId: `account-${suffix}`,
      accountName: `Session event append benchmark ${workspaceIndex}`,
      workspaceExternalSource: "session-event-append-benchmark",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: `Session event append benchmark ${workspaceIndex}`,
      subjectId: `benchmark:${suffix}`,
    });
    const grant = access.workspaceGrants[0];
    if (!grant) throw new Error("Benchmark workspace bootstrap returned no grant");
    const count = Math.floor(total / workspaces) + (workspaceIndex < total % workspaces ? 1 : 0);
    for (let sessionIndex = 0; sessionIndex < count; sessionIndex += 1) {
      const session = await createSession(db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        initialMessage: "session event append benchmark",
        resources: [],
        metadata: { benchmark: true, workspaceIndex, sessionIndex },
        model: "benchmark-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: grant.subjectId },
        createdByContext: {},
      });
      const started = await initializeSessionStartAtomically(db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        reasoningEffortFallback: "low",
        createdEventPayload: {},
        goal: null,
      });
      if (!started.turn) throw new Error("Benchmark session turn was not initialized");
      const attemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(db, grant.workspaceId, {
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      if (claimed.action !== "claimed") throw new Error("Benchmark turn was not claimed");
      fixtures.push({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId: claimed.turn.id,
        executionGeneration: claimed.turn.executionGeneration,
        attemptId,
      });
    }
  }
  return fixtures;
}

async function assertCrossTenantIsolation(
  appSql: postgres.Sql,
  sessions: RunningSession[],
): Promise<void> {
  const first = sessions[0];
  const other = sessions.find((session) => session.accountId !== first?.accountId);
  if (!first || !other) throw new Error("Benchmark requires sessions in distinct accounts");
  await appSql.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${first.accountId}, true),
      set_config('opengeni.workspace_id', ${first.workspaceId}, true),
      set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
    const [row] = await tx<{ count: number }[]>`
      select count(*)::integer as count from sessions where id = ${other.sessionId}::uuid
    `;
    if (row?.count !== 0) throw new Error("FORCE RLS leaked a cross-tenant benchmark session");
  });
}

async function runScenario(input: {
  name: string;
  topology: Topology;
  eventClass: EventClass;
  batchSize: number;
  concurrency: number;
  sampleCount: number;
  sessions: RunningSession[];
  db: BenchmarkDb;
}): Promise<ScenarioReceipt> {
  const latencies: number[] = [];
  const startedAt = performance.now();
  let cursor = 0;
  while (latencies.length < input.sampleCount) {
    const count = Math.min(input.concurrency, input.sampleCount - latencies.length);
    const wave = Array.from({ length: count }, (_, index) => {
      const fixture = input.sessions[(cursor + index) % input.sessions.length]!;
      return (async () => {
        const operationStartedAt = performance.now();
        await appendBatch(input.db, fixture, input.eventClass, input.batchSize, input.name);
        return performance.now() - operationStartedAt;
      })();
    });
    latencies.push(...(await Promise.all(wave)));
    cursor += count;
  }
  const elapsedSeconds = Math.max(0.000_001, (performance.now() - startedAt) / 1_000);
  return {
    name: input.name,
    topology: input.topology,
    eventClass: input.eventClass,
    batchSize: input.batchSize,
    concurrency: input.concurrency,
    latencyMs: distribution(latencies),
    throughputPerSecond: rounded(input.sampleCount / elapsedSeconds),
  };
}

async function appendBatch(
  db: BenchmarkDb,
  fixture: RunningSession,
  eventClass: EventClass,
  batchSize: number,
  scenario: string,
): Promise<void> {
  const operationId = crypto.randomUUID();
  const inputs = Array.from({ length: batchSize }, (_, index) =>
    eventClass === "raw"
      ? {
          type: "agent.message.delta" as const,
          payload: { text: "benchmark", operationId, index, scenario },
        }
      : {
          type: "agent.model.usage" as const,
          payload: {
            sourceKey: `benchmark:${operationId}:${index}`,
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        },
  );
  const result = await appendSessionEventsForTurnAttempt(
    db,
    fixture.workspaceId,
    fixture.sessionId,
    fixture.turnId,
    fixture.executionGeneration,
    fixture.attemptId,
    inputs,
  );
  if (!result.accepted || result.events.length !== batchSize) {
    throw new Error(`Benchmark append was rejected or lost events in ${scenario}`);
  }
  for (let index = 1; index < result.events.length; index += 1) {
    if (result.events[index]!.sequence !== result.events[index - 1]!.sequence + 1) {
      throw new Error(`Benchmark append returned a sequence gap in ${scenario}`);
    }
  }
}

async function durableInvariantAudit(
  admin: postgres.Sql,
  sessions: RunningSession[],
): Promise<{
  sessions: number;
  sequenceGapSessions: number;
  duplicateSequenceSessions: number;
  rejectedLateEvents: number;
  missingSessionRows: number;
  missingCursorRows: number;
  projectionAheadSessions: number;
}> {
  const ids = sessions.map((session) => session.sessionId);
  const rows = await admin<
    {
      sessionId: string;
      sessionSequence: number;
      cursorSequence: number | null;
      eventCount: number;
      distinctSequenceCount: number;
      minimumSequence: number;
      maximumSequence: number;
    }[]
  >`select
      session.id as "sessionId",
      session.last_sequence as "sessionSequence",
      cursor.last_sequence as "cursorSequence",
      count(event.id)::integer as "eventCount",
      count(distinct event.sequence)::integer as "distinctSequenceCount",
      coalesce(min(event.sequence), 0)::integer as "minimumSequence",
      coalesce(max(event.sequence), 0)::integer as "maximumSequence"
    from sessions session
    left join session_event_cursors cursor
      on cursor.account_id = session.account_id
     and cursor.workspace_id = session.workspace_id
     and cursor.session_id = session.id
    left join session_events event
      on event.workspace_id = session.workspace_id and event.session_id = session.id
    where session.id = any(${ids}::uuid[])
    group by session.id, session.last_sequence, cursor.last_sequence`;
  const sequenceGapSessions = rows.filter(
    (row) =>
      row.cursorSequence === null ||
      row.minimumSequence !== 1 ||
      row.maximumSequence !== row.cursorSequence ||
      row.eventCount !== row.cursorSequence,
  ).length;
  const duplicateSequenceSessions = rows.filter(
    (row) => row.eventCount !== row.distinctSequenceCount,
  ).length;
  const [late] = await admin<{ count: number }[]>`
    select count(*)::integer as count from session_events
    where session_id = any(${ids}::uuid[]) and type = 'turn.event.rejected_late'
  `;
  return {
    sessions: rows.length,
    sequenceGapSessions,
    duplicateSequenceSessions,
    rejectedLateEvents: late?.count ?? 0,
    missingSessionRows: Math.max(0, sessions.length - rows.length),
    missingCursorRows: rows.filter((row) => row.cursorSequence === null).length,
    projectionAheadSessions: rows.filter(
      (row) => row.cursorSequence !== null && row.sessionSequence > row.cursorSequence,
    ).length,
  };
}

function interleaveSessionsByWorkspace(sessions: RunningSession[]): RunningSession[] {
  const groups = new Map<string, RunningSession[]>();
  for (const session of sessions) {
    const group = groups.get(session.workspaceId) ?? [];
    group.push(session);
    groups.set(session.workspaceId, group);
  }
  const interleaved: RunningSession[] = [];
  const maximumGroupSize = Math.max(...[...groups.values()].map((group) => group.length));
  for (let index = 0; index < maximumGroupSize; index += 1) {
    for (const group of groups.values()) {
      const session = group[index];
      if (session) interleaved.push(session);
    }
  }
  return interleaved;
}

export function distribution(values: number[]): Distribution {
  if (values.length === 0) throw new Error("distribution requires at least one sample");
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (value: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(value * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    min: rounded(ordered[0]!),
    p50: rounded(percentile(0.5)),
    p95: rounded(percentile(0.95)),
    p99: rounded(percentile(0.99)),
    max: rounded(ordered.at(-1)!),
  };
}

export function scalingReceipts(scenarios: ScenarioReceipt[], maximumConcurrency: number) {
  return scenarios
    .filter((scenario) => scenario.topology !== "same_session" && scenario.concurrency === 1)
    .map((baseline) => {
      const candidate = scenarios.find(
        (scenario) =>
          scenario.topology === baseline.topology &&
          scenario.eventClass === baseline.eventClass &&
          scenario.batchSize === baseline.batchSize &&
          scenario.concurrency === maximumConcurrency,
      );
      if (!candidate) throw new Error(`Missing concurrency ${maximumConcurrency} scenario`);
      return {
        topology: baseline.topology,
        eventClass: baseline.eventClass,
        batchSize: baseline.batchSize,
        concurrency: maximumConcurrency,
        efficiency: rounded(
          candidate.throughputPerSecond /
            Math.max(0.000_001, baseline.throughputPerSecond * maximumConcurrency),
        ),
      };
    });
}

function evaluateFailures(
  scenarios: ScenarioReceipt[],
  scaling: ReturnType<typeof scalingReceipts>,
  audit: Awaited<ReturnType<typeof durableInvariantAudit>>,
  thresholds: { rawP95Ms: number; semanticP95Ms: number; minimumScalingEfficiency: number },
): string[] {
  const failures: string[] = [];
  for (const scenario of scenarios) {
    const maximum = scenario.eventClass === "raw" ? thresholds.rawP95Ms : thresholds.semanticP95Ms;
    if (scenario.latencyMs.p95 > maximum) {
      failures.push(`${scenario.name} p95: ${scenario.latencyMs.p95}ms > ${maximum}ms`);
    }
  }
  for (const receipt of scaling) {
    if (receipt.efficiency < thresholds.minimumScalingEfficiency) {
      failures.push(
        `${receipt.topology} ${receipt.eventClass} batch ${receipt.batchSize} scaling: ${receipt.efficiency} < ${thresholds.minimumScalingEfficiency}`,
      );
    }
  }
  if (audit.sequenceGapSessions > 0) failures.push("durable sequence gaps detected");
  if (audit.duplicateSequenceSessions > 0) failures.push("duplicate durable sequences detected");
  if (audit.rejectedLateEvents > 0) failures.push("ordinary benchmark appends were rejected late");
  if (audit.missingSessionRows > 0) failures.push("benchmark session rows were not durable");
  if (audit.missingCursorRows > 0) failures.push("benchmark session cursor rows were not durable");
  if (audit.projectionAheadSessions > 0) {
    failures.push("session compatibility projection led the authoritative cursor");
  }
  return failures;
}

function stringArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integerArgument(name: string, fallback: number): number {
  const value = stringArgument(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function integerListArgument(name: string, fallback: number[]): number[] {
  const value = stringArgument(name);
  if (value === undefined) return fallback;
  const parsed = value.split(",").map((entry) => Number.parseInt(entry.trim(), 10));
  if (parsed.length === 0 || parsed.some((entry) => !Number.isSafeInteger(entry))) {
    throw new Error(`${name} must be a comma-separated integer list`);
  }
  return [...new Set(parsed)].sort((left, right) => left - right);
}

function numberEnvironment(name: string, fallback: number): number {
  const environmentValue = process.env[name];
  if (!environmentValue) return fallback;
  const parsed = Number(environmentValue);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
