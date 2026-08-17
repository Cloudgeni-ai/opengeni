#!/usr/bin/env bun
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import { startTestServices } from "@opengeni/testing";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../packages/db/src/schema";

const CONCURRENCY_CASES = [1, 4, 16, 32] as const;
const SAMPLES = 7;
const services = await startTestServices({ temporal: false });
const client = createDb(services.databaseUrl, { max: 64 });

type Target = { workspaceId: string; sessionId: string };

try {
  await services.migrate();
  const sharedWorkspace = await createWorkspace("shared");
  const sharedTargets = await Promise.all(
    Array.from({ length: Math.max(...CONCURRENCY_CASES) }, async (_, index) => ({
      workspaceId: sharedWorkspace.workspaceId,
      sessionId: (
        await createSession(client.db, {
          accountId: sharedWorkspace.accountId,
          workspaceId: sharedWorkspace.workspaceId,
          initialMessage: `shared activity counter ${index}`,
          resources: [],
          tools: [],
          metadata: {},
          model: "scripted-model",
          sandboxBackend: "none",
        })
      ).id,
    })),
  );
  const isolatedTargets = await Promise.all(
    Array.from({ length: Math.max(...CONCURRENCY_CASES) }, async (_, index) => {
      const workspace = await createWorkspace(`isolated-${index}`);
      const session = await createSession(client.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        initialMessage: `isolated activity counter ${index}`,
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      return { workspaceId: workspace.workspaceId, sessionId: session.id };
    }),
  );

  const receipts = [];
  for (const concurrency of CONCURRENCY_CASES) {
    const shared = sharedTargets.slice(0, concurrency);
    const isolated = isolatedTargets.slice(0, concurrency);
    const sharedParallel = await measureIndependentTransactions(shared);
    const isolatedParallel = await measureIndependentTransactions(isolated);
    const sharedCoalesced = await measureCoalescedTransaction(shared);
    receipts.push({
      concurrency,
      sharedParallel,
      isolatedParallel,
      sharedCoalesced,
      sharedVsIsolatedWallRatio:
        sharedParallel.wallMs.p50 / Math.max(0.001, isolatedParallel.wallMs.p50),
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        samples: SAMPLES,
        invariant:
          "one workspace activity revision per independent transaction; one revision stamps every session changed together in one transaction",
        receipts,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.close();
  await services.down();
}
process.exit(0);

async function createWorkspace(label: string) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "bench:session-activity-counter",
    accountExternalId: `account:${label}:${suffix}`,
    accountName: `Activity counter ${label}`,
    workspaceExternalSource: "bench:session-activity-counter",
    workspaceExternalId: `workspace:${label}:${suffix}`,
    workspaceName: `Activity counter ${label}`,
    subjectId: `bench:session-activity-counter:${label}:${suffix}`,
  });
  const grant = access.workspaceGrants[0];
  if (!grant) throw new Error(`Activity-counter workspace ${label} was not created`);
  return grant;
}

async function measureIndependentTransactions(targets: readonly Target[]) {
  const revisionBefore = await totalRevision(targets);
  const walls: number[] = [];
  const operations: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const status = sample % 2 === 0 ? "running" : "idle";
    const wallStartedAt = performance.now();
    const elapsed = await Promise.all(
      targets.map(async (target) => {
        const startedAt = performance.now();
        await withWorkspaceSessionActivityRls(client.db, target.workspaceId, async (db) => {
          await db
            .update(schema.sessions)
            .set({ status, updatedAt: new Date() })
            .where(
              and(
                eq(schema.sessions.workspaceId, target.workspaceId),
                eq(schema.sessions.id, target.sessionId),
              ),
            );
        });
        return performance.now() - startedAt;
      }),
    );
    walls.push(performance.now() - wallStartedAt);
    operations.push(...elapsed);
  }
  const revisionDelta = (await totalRevision(targets)) - revisionBefore;
  const expectedRevisionDelta = targets.length * SAMPLES;
  if (revisionDelta !== expectedRevisionDelta) {
    throw new Error(
      `Independent activity transactions advanced ${revisionDelta}/${expectedRevisionDelta} revisions`,
    );
  }
  return {
    transactionCount: expectedRevisionDelta,
    workspaceCount: new Set(targets.map((target) => target.workspaceId)).size,
    wallMs: distribution(walls),
    operationMs: distribution(operations),
    revisionParity: "pass",
  };
}

async function measureCoalescedTransaction(targets: readonly Target[]) {
  const workspaceIds = new Set(targets.map((target) => target.workspaceId));
  if (workspaceIds.size !== 1) throw new Error("Coalesced control requires one workspace");
  const workspaceId = targets[0]!.workspaceId;
  const sessionIds = targets.map((target) => target.sessionId);
  const revisionBefore = await totalRevision(targets);
  const walls: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const status = sample % 2 === 0 ? "idle" : "running";
    const startedAt = performance.now();
    await withWorkspaceSessionActivityRls(client.db, workspaceId, async (db) => {
      await db
        .update(schema.sessions)
        .set({ status, updatedAt: new Date() })
        .where(
          and(
            eq(schema.sessions.workspaceId, workspaceId),
            inArray(schema.sessions.id, sessionIds),
          ),
        );
    });
    walls.push(performance.now() - startedAt);
  }
  const revisionDelta = (await totalRevision(targets)) - revisionBefore;
  if (revisionDelta !== SAMPLES) {
    throw new Error(
      `Coalesced activity transactions advanced ${revisionDelta}/${SAMPLES} revisions`,
    );
  }
  return {
    transactionCount: SAMPLES,
    sessionsPerTransaction: targets.length,
    wallMs: distribution(walls),
    revisionParity: "pass",
  };
}

async function totalRevision(targets: readonly Target[]): Promise<number> {
  const workspaceIds = [...new Set(targets.map((target) => target.workspaceId))];
  const rows = await client.db
    .select({
      workspaceId: schema.workspaceSessionActivityRevisions.workspaceId,
      revision: schema.workspaceSessionActivityRevisions.revision,
    })
    .from(schema.workspaceSessionActivityRevisions)
    .where(inArray(schema.workspaceSessionActivityRevisions.workspaceId, workspaceIds));
  if (rows.length !== workspaceIds.length) {
    throw new Error(`Read ${rows.length}/${workspaceIds.length} workspace activity counters`);
  }
  return rows.reduce((sum, row) => sum + Number(row.revision), 0);
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    samples: sorted.length,
    min: sorted[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1)!,
  };
}
