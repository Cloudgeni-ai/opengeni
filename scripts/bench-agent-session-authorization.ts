#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SessionAuthorizationPort } from "@opengeni/contracts";
import { requireSessionAuthorization } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import { startTestServices } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";

const sessionCount = integerArgument("--sessions", 10_000);
const sampleCount = integerArgument("--samples", 100);
const expectedLateral = stringArgument("--expect-lateral") ?? "denied";
if (sessionCount < 1_000 || sessionCount > 50_000) {
  throw new Error("--sessions must be between 1000 and 50000");
}
if (sampleCount < 10 || sampleCount > 10_000) {
  throw new Error("--samples must be between 10 and 10000");
}
if (!new Set(["allowed", "denied"]).has(expectedLateral)) {
  throw new Error("--expect-lateral must be allowed or denied");
}

const outputPath = resolve(
  stringArgument("--output") ??
    `${process.env.OPENGENI_EVIDENCE_DIR ?? "/tmp"}/agent-session-authorization-benchmark.json`,
);
const services = await startTestServices({ temporal: false });
let client: ReturnType<typeof createDb> | null = null;
let raw: ReturnType<typeof postgres> | null = null;

try {
  await services.migrate();
  client = createDb(services.databaseUrl);
  raw = postgres(services.databaseUrl, { max: 8 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "agent-authority-benchmark",
    accountExternalId: `account-${suffix}`,
    accountName: "Agent authority benchmark",
    workspaceExternalSource: "agent-authority-benchmark",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Agent authority benchmark",
    subjectId: `benchmark:${suffix}`,
  });
  const grant = access.workspaceGrants[0];
  if (!grant) throw new Error("Benchmark workspace bootstrap failed");

  const create = (parentSessionId?: string) =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      ...(parentSessionId ? { parentSessionId } : {}),
      initialMessage: "agent authority benchmark",
      resources: [],
      metadata: {},
      model: "benchmark-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      createdByContext: {},
    });
  const root = await create();
  const caller = await create(root.id);
  const sibling = await create(root.id);

  const generatedCount = sessionCount - 3;
  if (generatedCount > 0) {
    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (scopedDb) =>
      scopedDb.execute(sql`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, title,
          resources, tools, metadata, model, reasoning_effort, latency_mode,
          sandbox_backend, sandbox_group_id,
          parent_session_id, temporal_workflow_id, tool_policy
        )
        select
          md5(${grant.workspaceId} || ':agent-authority:' || generated.i::text)::uuid,
          ${grant.accountId}::uuid,
          ${grant.workspaceId}::uuid,
          'idle',
          'agent authority filler ' || generated.i,
          'Agent authority filler ' || generated.i,
          '[]'::jsonb,
          '[]'::jsonb,
          jsonb_build_object('bench_index', generated.i),
          'benchmark-model',
          'medium',
          'standard',
          'none',
          md5(${grant.workspaceId} || ':agent-authority:' || generated.i::text)::uuid,
          ${root.id}::uuid,
          'session-' || md5(${grant.workspaceId} || ':agent-authority:' || generated.i::text)::uuid::text,
          jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', ${root.id}::uuid)
        from generate_series(1, ${generatedCount}) as generated(i)
      `),
    );
  }

  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: caller.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  if (!started.turn) throw new Error("Benchmark caller turn was not initialized");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: caller.id,
    workflowId: `session-${caller.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("Benchmark caller turn was not claimed");

  const agentGrant = {
    ...grant,
    principalKind: "agent_attempt" as const,
    metadata: {
      sessionId: caller.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
    },
  };
  const allowHost: SessionAuthorizationPort = {
    authorizeSession: async () => ({ allowed: true, relatedSessionAccess: "root" }),
    resolveListScope: async () => ({ kind: "all" }),
  };
  const authorize = async (sessionId: string, operation: "session.read" | "session.append") =>
    await requireSessionAuthorization(
      { db: client!.db, sessionAuthorization: allowHost },
      agentGrant,
      { sessionId, operation, surface: "first_party_mcp" },
    );

  for (let index = 0; index < 10; index += 1) {
    await authorize(caller.id, "session.read");
    await authorize(root.id, "session.append");
  }
  const selfReadMs = await samples(sampleCount, () => authorize(caller.id, "session.read"));
  const parentAppendMs = await samples(sampleCount, () => authorize(root.id, "session.append"));
  const lateralReadMs: number[] = [];
  let lateralDenied = true;
  for (let index = 0; index < sampleCount; index += 1) {
    const began = performance.now();
    try {
      await authorize(sibling.id, "session.read");
      lateralDenied = false;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "SessionAuthorizationDeniedError") {
        throw error;
      }
    }
    lateralReadMs.push(performance.now() - began);
  }
  const parallelStarted = performance.now();
  await Promise.all(Array.from({ length: 32 }, () => authorize(caller.id, "session.read")));
  const parallel32Ms = performance.now() - parallelStarted;

  const planRows = await raw.unsafe(
    `explain (analyze, buffers, format json)
      select id, parent_session_id, root_session_id
      from sessions
      where workspace_id = $1::uuid and id = $2::uuid`,
    [grant.workspaceId, sibling.id],
  );
  const metrics = {
    sessionCount,
    sampleCount,
    selfReadMs: distribution(selfReadMs),
    parentAppendMs: distribution(parentAppendMs),
    lateralReadMs: distribution(lateralReadMs),
    lateralDenied,
    parallel32Ms,
  };
  const thresholds = {
    singleP95Ms: numberEnvironment("OPENGENI_BENCH_AGENT_AUTH_P95_MS", 75),
    parallel32Ms: numberEnvironment("OPENGENI_BENCH_AGENT_AUTH_PARALLEL_MS", 2_000),
  };
  const failures = [
    ...check(metrics.selfReadMs.p95, thresholds.singleP95Ms, "self read p95"),
    ...check(metrics.parentAppendMs.p95, thresholds.singleP95Ms, "parent append p95"),
    ...check(metrics.lateralReadMs.p95, thresholds.singleP95Ms, "lateral decision p95"),
    ...check(metrics.parallel32Ms, thresholds.parallel32Ms, "32-way authorization"),
    ...(lateralDenied === (expectedLateral === "denied")
      ? []
      : [`lateral decision was ${lateralDenied ? "denied" : "allowed"}`]),
  ];
  const receipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    expectedLateral,
    metrics,
    thresholds,
    failures,
    targetLookupPlan: planRows,
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

async function samples(count: number, run: () => Promise<unknown>): Promise<number[]> {
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
