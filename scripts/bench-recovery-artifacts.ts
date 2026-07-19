#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import {
  admitRecoveryArtifact,
  bootstrapWorkspace,
  createDb,
  persistRecoveryArtifact,
  precomputeRecoveryArtifact,
  type RecoveryArtifactObservability,
} from "@opengeni/db";
import { startTestServices } from "@opengeni/testing";

const sessionCount = integerArgument("--sessions", 10_000);
if (![1_000, 4_000, 10_000].includes(sessionCount)) {
  throw new Error("--sessions must be one of 1000, 4000, or 10000");
}
const outputPath = resolve(
  stringArgument("--output") ??
    `${process.env.OPENGENI_EVIDENCE_DIR ?? "/tmp"}/recovery-artifacts-${sessionCount}.json`,
);

const externalAdminUrl = process.env.OPENGENI_TEST_DATABASE_ADMIN_URL;
const externalAppUrl = process.env.OPENGENI_TEST_DATABASE_URL;
const services =
  externalAdminUrl && externalAppUrl ? null : await startTestServices({ temporal: false });
if (services) await services.migrate();
const adminUrl = externalAdminUrl ?? services!.databaseUrl;
const appUrl = externalAppUrl ?? services!.databaseUrl;
const admin = postgres(adminUrl, { max: 2 });
const app = postgres(appUrl, { max: 2 });
const client = createDb(appUrl);
let workspaceId: string | null = null;

try {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "ope62-benchmark",
    accountExternalId: `account-${suffix}`,
    accountName: "OPE-62 recovery artifact benchmark",
    workspaceExternalSource: "ope62-benchmark",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "OPE-62 recovery artifact benchmark",
    subjectId: `benchmark-${suffix}`,
  });
  const grant = access.workspaceGrants[0];
  if (!grant?.workspaceId) throw new Error("benchmark workspace bootstrap failed");
  const accountId = grant.accountId;
  workspaceId = grant.workspaceId;
  const rootSessionId = crypto.randomUUID();

  const seedStarted = performance.now();
  await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
    await tx`
      insert into sessions (
        id, account_id, workspace_id, status, initial_message, title,
        resources, tools, metadata, model, sandbox_backend, sandbox_group_id,
        temporal_workflow_id
      ) values (
        ${rootSessionId}::uuid, ${accountId}::uuid, ${workspaceId}::uuid, 'idle',
        'benchmark root', 'Benchmark root', '[]'::jsonb, '[]'::jsonb,
        jsonb_build_object('bench_index', 0), 'benchmark-model', 'none',
        ${rootSessionId}::uuid, ${`session-${rootSessionId}`}
      )`;
    if (sessionCount > 1) {
      await tx`
        with generated as materialized (
          select i, gen_random_uuid() as id
          from generate_series(1, ${sessionCount - 1}) as series(i)
        )
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, title,
          resources, tools, metadata, model, sandbox_backend, sandbox_group_id,
          parent_session_id, temporal_workflow_id
        )
        select
          generated.id,
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
          generated.id,
          ${rootSessionId}::uuid,
          'session-' || generated.id::text
        from generated`;
    }
    await tx`
      insert into session_events (
        id, account_id, workspace_id, session_id, sequence, type, payload
      )
      select
        md5(${workspaceId} || ':event:' || (session.metadata ->> 'bench_index'))::uuid,
        ${accountId}::uuid,
        ${workspaceId}::uuid,
        session.id,
        1,
        'ope62.benchmark',
        jsonb_build_object(
          'index', (session.metadata ->> 'bench_index')::integer,
          'padding', repeat('x', 128)
        )
      from sessions session
      where session.workspace_id = ${workspaceId}::uuid`;
    await tx`update sessions set last_sequence = 1
             where workspace_id = ${workspaceId}::uuid`;
  });
  const seedMs = performance.now() - seedStarted;

  const baseline = process.memoryUsage();
  const firstProfile = await profileMemory(() =>
    precomputeRecoveryArtifact(client.db, {
      accountId,
      workspaceId: workspaceId!,
      rootSessionId,
    }),
  );
  const artifact = firstProfile.value;
  const retryProfile = await profileMemory(() =>
    precomputeRecoveryArtifact(client.db, {
      accountId,
      workspaceId: workspaceId!,
      rootSessionId,
    }),
  );

  const persistStarted = performance.now();
  await persistRecoveryArtifact(client.db, { accountId, artifact });
  const persistMs = performance.now() - persistStarted;

  const telemetry: Array<{
    name: string;
    labels?: Record<string, string | number | boolean | null | undefined>;
    value?: number;
  }> = [];
  const observability: RecoveryArtifactObservability = {
    incrementCounter: (input) => telemetry.push(input),
    observeHistogram: (input) => telemetry.push(input),
  };
  const admissionStarted = performance.now();
  const admission = await admitRecoveryArtifact(client.db, {
    accountId,
    artifact,
    idempotencyKey: `benchmark-${sessionCount}`,
    observability,
  });
  const admissionMs = performance.now() - admissionStarted;
  if (admission.kind !== "admitted" || admission.reused) {
    throw new Error("benchmark artifact was not admitted exactly once");
  }

  const childScript = fileURLToPath(
    new URL("../packages/db/test/fixtures/recovery-artifact-db-process.ts", import.meta.url),
  );
  const child = Bun.spawn([process.execPath, childScript], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ appUrl, accountId, workspaceId, rootSessionId }));
  child.stdin.end();
  const [childStdout, childStderr, childExit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (childExit !== 0) throw new Error(`independent precompute failed: ${childStderr.trim()}`);
  const independent = JSON.parse(childStdout) as {
    artifactHash: string;
    sessionCount: number;
    eventCount: number;
    canonicalBytes: number;
  };

  const finalLockWaitSeconds = metricValue(
    telemetry,
    "opengeni_recovery_artifact_final_lock_wait_seconds",
  );
  const finalLockHoldSeconds = metricValue(
    telemetry,
    "opengeni_recovery_artifact_final_lock_hold_seconds",
  );
  const metrics = {
    sessionCount,
    eventCount: artifact.manifest.eventCount,
    canonicalBytes: artifact.manifest.canonicalBytes,
    seedMs,
    precomputeMs: firstProfile.durationMs,
    retryPrecomputeMs: retryProfile.durationMs,
    persistMs,
    admissionMs,
    finalLockWaitSeconds,
    finalLockHoldSeconds,
    rssBaselineBytes: baseline.rss,
    rssPeakBytes: Math.max(firstProfile.peakRssBytes, retryProfile.peakRssBytes),
    rssDeltaBytes: Math.max(
      0,
      Math.max(firstProfile.peakRssBytes, retryProfile.peakRssBytes) - baseline.rss,
    ),
    heapBaselineBytes: baseline.heapUsed,
    heapPeakBytes: Math.max(firstProfile.peakHeapBytes, retryProfile.peakHeapBytes),
    heapDeltaBytes: Math.max(
      0,
      Math.max(firstProfile.peakHeapBytes, retryProfile.peakHeapBytes) - baseline.heapUsed,
    ),
  };
  const thresholds = {
    seedMs: numberEnvironment("OPENGENI_RECOVERY_BENCH_SEED_MS", 180_000),
    precomputeMs: numberEnvironment("OPENGENI_RECOVERY_BENCH_PRECOMPUTE_MS", 60_000),
    admissionMs: numberEnvironment("OPENGENI_RECOVERY_BENCH_ADMISSION_MS", 10_000),
    finalLockHoldSeconds: numberEnvironment("OPENGENI_RECOVERY_BENCH_FINAL_LOCK_SECONDS", 2),
    rssDeltaBytes: numberEnvironment("OPENGENI_RECOVERY_BENCH_RSS_DELTA_BYTES", 768 * 1024 * 1024),
    heapDeltaBytes: numberEnvironment(
      "OPENGENI_RECOVERY_BENCH_HEAP_DELTA_BYTES",
      512 * 1024 * 1024,
    ),
  };
  const deterministic =
    retryProfile.value.artifactHash === artifact.artifactHash &&
    independent.artifactHash === artifact.artifactHash &&
    independent.sessionCount === artifact.manifest.sessionCount &&
    independent.eventCount === artifact.manifest.eventCount &&
    independent.canonicalBytes === artifact.manifest.canonicalBytes;
  const failures = [
    ...(deterministic ? [] : ["artifact checksum or aggregate changed across retries/processes"]),
    ...check(metrics.seedMs, thresholds.seedMs, "seed wall time"),
    ...check(metrics.precomputeMs, thresholds.precomputeMs, "precompute wall time"),
    ...check(metrics.retryPrecomputeMs, thresholds.precomputeMs, "retry precompute wall time"),
    ...check(metrics.admissionMs, thresholds.admissionMs, "admission wall time"),
    ...check(
      metrics.finalLockHoldSeconds,
      thresholds.finalLockHoldSeconds,
      "final barrier lock hold",
    ),
    ...check(metrics.rssDeltaBytes, thresholds.rssDeltaBytes, "RSS delta"),
    ...check(metrics.heapDeltaBytes, thresholds.heapDeltaBytes, "heap delta"),
  ];
  const receipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    artifactHash: artifact.artifactHash,
    deterministic,
    metrics,
    thresholds,
    failures,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outputPath, ...receipt })}\n`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  if (workspaceId) {
    await admin`delete from workspaces where id = ${workspaceId}::uuid`.catch(() => undefined);
  }
  await client.close().catch(() => undefined);
  await app.end().catch(() => undefined);
  await admin.end().catch(() => undefined);
  await services?.down().catch(() => undefined);
}

async function profileMemory<T>(run: () => Promise<T>): Promise<{
  value: T;
  durationMs: number;
  peakRssBytes: number;
  peakHeapBytes: number;
}> {
  let peakRssBytes = process.memoryUsage().rss;
  let peakHeapBytes = process.memoryUsage().heapUsed;
  const sample = () => {
    const memory = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
    peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed);
  };
  const timer = setInterval(sample, 10);
  const started = performance.now();
  try {
    const value = await run();
    sample();
    return { value, durationMs: performance.now() - started, peakRssBytes, peakHeapBytes };
  } finally {
    clearInterval(timer);
  }
}

function metricValue(metrics: Array<{ name: string; value?: number }>, name: string): number {
  const value = metrics.find((entry) => entry.name === name)?.value;
  if (typeof value !== "number") throw new Error(`missing benchmark metric ${name}`);
  return value;
}

function check(value: number, maximum: number, label: string): string[] {
  return Number.isFinite(value) && value <= maximum
    ? []
    : [`${label} ${value} exceeded ${maximum}`];
}

function integerArgument(name: string, fallback: number): number {
  const raw = stringArgument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function stringArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function numberEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}
