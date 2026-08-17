#!/usr/bin/env bun
import { gzipSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSessionQueueSnapshot,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import { startTestServices } from "@opengeni/testing";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as schema from "../packages/db/src/schema";

const queueSize = Number(process.env.QUEUE_BREAKDOWN_SIZE ?? "5000");
const samples = Number(process.env.QUEUE_BREAKDOWN_SAMPLES ?? "7");
const payloadPrefix = process.env.QUEUE_BREAKDOWN_PAYLOAD_PREFIX;
if (!Number.isSafeInteger(queueSize) || queueSize < 1 || queueSize > 10_000) {
  throw new TypeError("QUEUE_BREAKDOWN_SIZE must be an integer from 1 through 10000");
}
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 50) {
  throw new TypeError("QUEUE_BREAKDOWN_SAMPLES must be an integer from 1 through 50");
}
if (queueSize < samples * 2 + 1) {
  throw new TypeError(
    "QUEUE_BREAKDOWN_SIZE must leave distinct rows for sparse move/delete samples",
  );
}

const services = await startTestServices({ temporal: false });
const client = createDb(services.databaseUrl);

try {
  await migrateQuietly();
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "bench:turn-queue-cost-breakdown",
    accountExternalId: `account:${suffix}`,
    accountName: "Turn queue cost breakdown",
    workspaceExternalSource: "bench:turn-queue-cost-breakdown",
    workspaceExternalId: `workspace:${suffix}`,
    workspaceName: "Turn queue cost breakdown",
    subjectId: `bench:turn-queue-cost-breakdown:${suffix}`,
  });
  const grant = access.workspaceGrants[0];
  if (!grant) throw new Error("benchmark workspace grant was not created");
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "measure queue costs",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });

  await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, async (db) => {
    for (let offset = 0; offset < queueSize; offset += 500) {
      const length = Math.min(500, queueSize - offset);
      await db.insert(schema.sessionTurns).values(
        Array.from({ length }, (_, index) => {
          const ordinal = offset + index + 1;
          const unique = crypto.randomUUID();
          return {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId: session.id,
            triggerEventId: crypto.randomUUID(),
            temporalWorkflowId: `session-${session.id}`,
            status: "queued" as const,
            source: "user" as const,
            position: ordinal,
            prompt: `queued prompt ${ordinal} ${unique.repeat(13)}`,
            resources: [],
            tools: [],
            model: "scripted-model",
            reasoningEffort: "medium" as const,
            sandboxBackend: "none" as const,
            metadata: {},
          };
        }),
      );
    }
    await db
      .update(schema.sessions)
      .set({
        queueVersion: 1,
        queueHeadPosition: 0,
        queueTailPosition: queueSize,
        status: "queued",
      })
      .where(eq(schema.sessions.id, session.id));
  });

  const snapshot = await requiredSnapshot();
  const serialized = JSON.stringify(snapshot);
  const compressed = gzipSync(serialized);
  const currentQueueUiProjection = {
    ...snapshot,
    items: snapshot.items.map((turn) => ({
      id: turn.id,
      source: turn.source,
      position: turn.position,
      prompt: turn.prompt,
      annotations: turn.annotations,
      resources: turn.resources,
      tools: turn.tools,
      model: turn.model,
      reasoningEffort: turn.reasoningEffort,
      latencyMode: turn.latencyMode,
      metadata: turn.metadata,
      version: turn.version,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
    })),
  };
  const currentQueueUiSerialized = JSON.stringify(currentQueueUiProjection);
  const currentQueueUiCompressed = gzipSync(currentQueueUiSerialized);
  if (payloadPrefix) {
    await Promise.all([
      writeFile(`${payloadPrefix}-canonical.json`, serialized),
      writeFile(`${payloadPrefix}-queue-ui.json`, currentQueueUiSerialized),
    ]);
  }

  await requiredSnapshot();
  const snapshotMs = await timed(samples, requiredSnapshot);

  const fullRows = async () =>
    await withWorkspaceSessionActivityRls(
      client.db,
      grant.workspaceId,
      async (db) =>
        await db
          .select()
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, grant.workspaceId),
              eq(schema.sessionTurns.sessionId, session.id),
              eq(schema.sessionTurns.status, "queued"),
              inArray(schema.sessionTurns.source, ["user", "api"]),
            ),
          )
          .orderBy(asc(schema.sessionTurns.position), asc(schema.sessionTurns.createdAt)),
    );
  await fullRows();
  const fullRowsMs = await timed(samples, fullRows);

  const idsOnly = async () =>
    await withWorkspaceSessionActivityRls(
      client.db,
      grant.workspaceId,
      async (db) =>
        await db
          .select({ id: schema.sessionTurns.id, position: schema.sessionTurns.position })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, grant.workspaceId),
              eq(schema.sessionTurns.sessionId, session.id),
              eq(schema.sessionTurns.status, "queued"),
              inArray(schema.sessionTurns.source, ["user", "api"]),
            ),
          )
          .orderBy(asc(schema.sessionTurns.position), asc(schema.sessionTurns.createdAt)),
    );
  const ordered = await idsOnly();
  const idsOnlyMs = await timed(samples, idsOnly);

  const serializeMs = await timedSync(samples, () => JSON.stringify(snapshot));
  const parseMs = await timedSync(samples, () => JSON.parse(serialized));
  const gzipMs = await timedSync(samples, () => gzipSync(serialized));

  const orderedValues = sql.join(
    ordered.map((row, index) => sql`(${row.id}::uuid, ${index + 1}::bigint)`),
    sql`, `,
  );
  const normalizeAll = async () =>
    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, async (db) => {
      await db.execute(sql`
        with ordered(id, position) as (values ${orderedValues})
        update ${schema.sessionTurns} turn
        set position = ordered.position, updated_at = now()
        from ordered
        where turn.workspace_id = ${grant.workspaceId}
          and turn.session_id = ${session.id}
          and turn.id = ordered.id
          and turn.status = 'queued'
      `);
      await db
        .update(schema.sessions)
        .set({ queueHeadPosition: 0, queueTailPosition: ordered.length, updatedAt: new Date() })
        .where(
          and(
            eq(schema.sessions.workspaceId, grant.workspaceId),
            eq(schema.sessions.id, session.id),
          ),
        );
    });
  await normalizeAll();
  const normalizeAllMs = await timed(samples, normalizeAll);

  let sparseHead = -1;
  let sparseIndex = ordered.length - 1;
  const sparseMoveToHead = async () => {
    const target = ordered[sparseIndex]!;
    sparseIndex -= 1;
    sparseHead -= 1;
    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, async (db) => {
      await db
        .update(schema.sessionTurns)
        .set({
          position: sparseHead,
          version: sql`${schema.sessionTurns.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, grant.workspaceId),
            eq(schema.sessionTurns.sessionId, session.id),
            eq(schema.sessionTurns.id, target.id),
            eq(schema.sessionTurns.status, "queued"),
          ),
        );
      await db
        .update(schema.sessions)
        .set({
          queueHeadPosition: sparseHead,
          queueVersion: sql`${schema.sessions.queueVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.sessions.workspaceId, grant.workspaceId),
            eq(schema.sessions.id, session.id),
          ),
        );
    });
  };
  const sparseMoveToHeadMs = await timed(samples, sparseMoveToHead);

  let sparseDeleteIndex = Math.max(0, ordered.length - samples - 2);
  const sparseDelete = async () => {
    const target = ordered[sparseDeleteIndex]!;
    sparseDeleteIndex -= 1;
    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, async (db) => {
      await db
        .update(schema.sessionTurns)
        .set({
          status: "cancelled",
          version: sql`${schema.sessionTurns.version} + 1`,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, grant.workspaceId),
            eq(schema.sessionTurns.sessionId, session.id),
            eq(schema.sessionTurns.id, target.id),
            eq(schema.sessionTurns.status, "queued"),
          ),
        );
      await db
        .update(schema.sessions)
        .set({ queueVersion: sql`${schema.sessions.queueVersion} + 1`, updatedAt: new Date() })
        .where(
          and(
            eq(schema.sessions.workspaceId, grant.workspaceId),
            eq(schema.sessions.id, session.id),
          ),
        );
    });
  };
  const sparseDeleteMs = await timed(samples, sparseDelete);
  const sparseFinal = await idsOnly();
  const expectedRemaining = queueSize - samples;
  const sparseAssertions = {
    deletedRowsAbsent: sparseFinal.length === expectedRemaining,
    movedRowsLeadInLastMoveFirstOrder: sparseFinal
      .slice(0, samples)
      .every((row, index) => row.id === ordered[ordered.length - samples + index]?.id),
    positionsStrictlyIncreasing: sparseFinal.every(
      (row, index) => index === 0 || row.position > sparseFinal[index - 1]!.position,
    ),
    idsUnique: new Set(sparseFinal.map((row) => row.id)).size === sparseFinal.length,
  };
  if (Object.values(sparseAssertions).some((value) => !value)) {
    throw new Error(`sparse queue proof failed: ${JSON.stringify(sparseAssertions)}`);
  }

  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        queueSize,
        promptCharacters: snapshot.items.reduce((sum, turn) => sum + turn.prompt.length, 0),
        responseBytes: {
          canonical: {
            json: Buffer.byteLength(serialized),
            gzip: compressed.byteLength,
            gzipRatio: compressed.byteLength / Buffer.byteLength(serialized),
          },
          currentQueueUiProjection: {
            json: Buffer.byteLength(currentQueueUiSerialized),
            gzip: currentQueueUiCompressed.byteLength,
            gzipRatio:
              currentQueueUiCompressed.byteLength / Buffer.byteLength(currentQueueUiSerialized),
          },
        },
        timingsMs: {
          authoritativeSnapshot: distribution(snapshotMs),
          fullQueueRowsOnly: distribution(fullRowsMs),
          queueIdsOnly: distribution(idsOnlyMs),
          jsonSerialize: distribution(serializeMs),
          jsonParse: distribution(parseMs),
          gzip: distribution(gzipMs),
          normalizeEveryPosition: distribution(normalizeAllMs),
          experimentalSparseMoveToHead: distribution(sparseMoveToHeadMs),
          experimentalSparseDelete: distribution(sparseDeleteMs),
        },
        interpretation: {
          normalizeEveryPosition:
            "Current mutation primitive rewritten in isolation; it intentionally excludes authorization, locks, receipts, events, snapshot reload, NATS, and HTTP.",
          experimentalSparseMoveToHead:
            "One-row negative-head position update plus the session head pointer. This is a measurement, not a production patch.",
          experimentalSparseDelete:
            "One-row terminal status update plus queue-version increment, leaving stable sparse positions. This is a measurement, not a production patch.",
          currentQueueUiProjection:
            "Every row and exact current queue-UI field, including prompt, annotations, resources, tools, model, reasoning, metadata, versions, and timestamps; only server execution/tenant fields are excluded. This is a size measurement, not a contract patch.",
        },
        sparseAssertions,
      },
      null,
      2,
    ),
  );

  async function requiredSnapshot() {
    const value = await getSessionQueueSnapshot(client.db, grant.workspaceId, session.id);
    if (!value) throw new Error("queue snapshot was not found");
    return value;
  }
} finally {
  await client.close();
  await services.down();
}
process.exit(0);

async function migrateQuietly(): Promise<void> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    await services.migrate();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

async function timed<T>(sampleCount: number, operation: () => Promise<T>): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = performance.now();
    await operation();
    values.push(performance.now() - startedAt);
  }
  return values;
}

async function timedSync<T>(sampleCount: number, operation: () => T): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = performance.now();
    operation();
    values.push(performance.now() - startedAt);
  }
  return values;
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
  };
}
