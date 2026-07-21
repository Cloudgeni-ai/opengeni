#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import postgres from "postgres";

import {
  bootstrapWorkspace,
  createDb,
  evaluateSessionControl,
  evaluateSessionControls,
  mutateSessionControlInTransaction,
} from "@opengeni/db";
import { startTestServices } from "@opengeni/testing";

const sessionCount = integerArgument("--sessions", 10_000);
if (sessionCount < 1_000 || sessionCount > 50_000) {
  throw new Error("--sessions must be between 1000 and 50000");
}
const outputPath = resolve(
  stringArgument("--output") ??
    `${process.env.OPENGENI_EVIDENCE_DIR ?? "/tmp"}/session-control-benchmark.json`,
);
const depth = Math.min(128, sessionCount - 1);
const services = await startTestServices({ temporal: false });
let client: ReturnType<typeof createDb> | null = null;
let raw: ReturnType<typeof postgres> | null = null;

try {
  await services.migrate();
  client = createDb(services.databaseUrl);
  raw = postgres(services.databaseUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "benchmark",
    accountExternalId: `account-${suffix}`,
    accountName: "Session control benchmark",
    workspaceExternalSource: "benchmark",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session control benchmark",
    subjectId: `benchmark-${suffix}`,
  });
  const grant = access.workspaceGrants[0];
  if (!grant?.workspaceId) throw new Error("Benchmark workspace bootstrap failed");
  const workspaceId = grant.workspaceId;
  const accountId = grant.accountId;
  const subjectId = grant.subjectId;
  const rootId = crypto.randomUUID();

  await raw`
    insert into sessions (
      id, account_id, workspace_id, status, initial_message, title,
      resources, tools, metadata, model, sandbox_backend, sandbox_group_id,
      temporal_workflow_id
    ) values (
      ${rootId}::uuid, ${accountId}::uuid, ${workspaceId}::uuid, 'idle',
      'benchmark root', 'Benchmark root', '[]'::jsonb, '[]'::jsonb,
      jsonb_build_object('bench_index', 0), 'benchmark-model', 'none',
      ${rootId}::uuid, ${`session-${rootId}`}
    )
  `;
  if (sessionCount > 1) {
    await raw`
      insert into sessions (
        id, account_id, workspace_id, status, initial_message, title,
        resources, tools, metadata, model, sandbox_backend, sandbox_group_id,
        parent_session_id, temporal_workflow_id
      )
      select
        md5(${workspaceId} || ':' || generated.i::text)::uuid,
        ${accountId}::uuid,
        ${workspaceId}::uuid,
        'idle',
        'benchmark session ' || generated.i,
        'Benchmark ' || generated.i,
        '[]'::jsonb,
        '[]'::jsonb,
        jsonb_build_object('bench_index', generated.i),
        'benchmark-model',
        'none',
        md5(${workspaceId} || ':' || generated.i::text)::uuid,
        case
          when generated.i = 1 then ${rootId}::uuid
          when generated.i <= ${depth}
            then md5(${workspaceId} || ':' || (generated.i - 1)::text)::uuid
          else md5(${workspaceId} || ':' || (1 + ((generated.i - ${depth} - 1) % ${depth}))::text)::uuid
        end,
        'session-' || md5(${workspaceId} || ':' || generated.i::text)::uuid::text
      from generate_series(1, ${sessionCount - 1}) as generated(i)
    `;
  }

  const sessionRows = await raw<{ id: string; benchIndex: number }[]>`
    select id, (metadata ->> 'bench_index')::integer as "benchIndex"
    from sessions
    where workspace_id = ${workspaceId}::uuid
    order by (metadata ->> 'bench_index')::integer
  `;
  const sessionIds = sessionRows.map((row) => row.id);
  if (sessionIds.length !== sessionCount) {
    throw new Error(`Seeded ${sessionIds.length} sessions; expected ${sessionCount}`);
  }
  const deepLeafId = sessionIds[depth]!;

  for (let index = 0; index < 3; index += 1) {
    await evaluateSessionControl(client.db, workspaceId, deepLeafId);
  }
  const rssBefore = process.memoryUsage().rss;
  const singleActiveMs = await samples(50, async () => {
    await evaluateSessionControl(client!.db, workspaceId, deepLeafId);
  });
  const batchActiveMs = await samples(3, async () => {
    const controls = await evaluateSessionControls(client!.db, workspaceId, sessionIds);
    if (controls.size !== sessionCount) throw new Error("Set evaluator omitted sessions");
  });
  const parallelStarted = performance.now();
  await Promise.all(
    Array.from({ length: 32 }, (_, worker) => {
      const begin = Math.floor((worker * sessionIds.length) / 32);
      const end = Math.floor(((worker + 1) * sessionIds.length) / 32);
      return evaluateSessionControls(client!.db, workspaceId, sessionIds.slice(begin, end));
    }),
  );
  const parallelReadsMs = performance.now() - parallelStarted;

  const pauseStarted = performance.now();
  await client.db.transaction((tx) =>
    mutateSessionControlInTransaction(tx as ReturnType<typeof createDb>["db"], {
      accountId,
      workspaceId,
      sessionId: rootId,
      actor: { type: "human", subjectId },
      operationKey: crypto.randomUUID(),
      action: "pause",
      reason: "benchmark recursive barrier",
    }),
  );
  const rootPauseMs = performance.now() - pauseStarted;
  const singlePausedMs = await samples(50, async () => {
    const control = await evaluateSessionControl(client!.db, workspaceId, deepLeafId);
    if (control.state !== "paused") throw new Error("Recursive Pause projection was not inherited");
  });
  const batchPausedMs = await samples(3, async () => {
    const controls = await evaluateSessionControls(client!.db, workspaceId, sessionIds);
    if ([...controls.values()].some((control) => control.state !== "paused")) {
      throw new Error("Recursive Pause did not cover every seeded descendant");
    }
  });
  const rssAfter = process.memoryUsage().rss;

  const planRows = await raw.unsafe(
    `explain (analyze, buffers, format json)
      with recursive ancestry as (
        select id, parent_session_id, 0::integer as depth
        from sessions where workspace_id = $1::uuid and id = $2::uuid
        union all
        select parent.id, parent.parent_session_id, child.depth + 1
        from ancestry child
        join sessions parent
          on parent.workspace_id = $1::uuid and parent.id = child.parent_session_id
        where child.depth < 256
      )
      select * from ancestry`,
    [workspaceId, deepLeafId],
  );

  const metrics = {
    sessionCount,
    depth,
    singleActiveMs: distribution(singleActiveMs),
    batchActiveMs: distribution(batchActiveMs),
    singlePausedMs: distribution(singlePausedMs),
    batchPausedMs: distribution(batchPausedMs),
    rootPauseMs,
    parallelReadsMs,
    rssBeforeBytes: rssBefore,
    rssAfterBytes: rssAfter,
    rssDeltaBytes: Math.max(0, rssAfter - rssBefore),
  };
  const thresholds = {
    singleP95Ms: numberEnvironment("OPENGENI_BENCH_SINGLE_P95_MS", 75),
    batchP95Ms: numberEnvironment("OPENGENI_BENCH_BATCH_P95_MS", 5_000),
    rootPauseMs: numberEnvironment("OPENGENI_BENCH_ROOT_PAUSE_MS", 2_000),
    parallelReadsMs: numberEnvironment("OPENGENI_BENCH_PARALLEL_READS_MS", 5_000),
    rssDeltaBytes: numberEnvironment("OPENGENI_BENCH_RSS_DELTA_BYTES", 512 * 1024 * 1024),
  };
  const failures = [
    ...check(metrics.singleActiveMs.p95, thresholds.singleP95Ms, "active single-target p95"),
    ...check(metrics.singlePausedMs.p95, thresholds.singleP95Ms, "paused single-target p95"),
    ...check(metrics.batchActiveMs.p95, thresholds.batchP95Ms, "active 10k batch p95"),
    ...check(metrics.batchPausedMs.p95, thresholds.batchP95Ms, "paused 10k batch p95"),
    ...check(metrics.rootPauseMs, thresholds.rootPauseMs, "10k recursive Pause commit"),
    ...check(metrics.parallelReadsMs, thresholds.parallelReadsMs, "32-way set reads"),
    ...check(metrics.rssDeltaBytes, thresholds.rssDeltaBytes, "RSS delta"),
  ];
  const receipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    metrics,
    thresholds,
    failures,
    ancestryPlan: planRows,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outputPath, metrics, thresholds, failures })}\n`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await raw?.end().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await services.down();
}

async function samples(count: number, run: () => Promise<void>): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await run();
    values.push(performance.now() - started);
  }
  return values;
}

function distribution(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (value: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(value * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: ordered.at(-1)!,
  };
}

function check(actual: number, maximum: number, label: string): string[] {
  return actual <= maximum ? [] : [`${label}: ${actual.toFixed(2)} > ${maximum.toFixed(2)}`];
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

function numberEnvironment(name: string, fallback: number): number {
  const environmentValue = process.env[name];
  if (!environmentValue) return fallback;
  const parsed = Number(environmentValue);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}
