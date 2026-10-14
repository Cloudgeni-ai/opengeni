import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
} from "@opengeni/db";
import {
  editableArtifactClientTransactionId,
  editableArtifactId,
  editableArtifactReplicaId,
  editableArtifactScope,
  editableArtifactStateHash,
} from "@opengeni/core/editable-artifacts";
import type { ObjectHead, ObjectStorage } from "@opengeni/storage";
import { createStandaloneEditableArtifactApplication } from "../src/editable-artifact-production";

// Real native kernel plus real PostgreSQL authority, no model. The kernel
// derives each operation identity from the intent digest and command index, so
// a multi-command spreadsheet batch almost never has lexically ordered
// identities. Those identities must persist and replay in command order.

let shared: SharedTestDatabase;
let database: ReturnType<typeof createDb>;
let application: Awaited<ReturnType<typeof createStandaloneEditableArtifactApplication>>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("native-spreadsheet-transaction-order");
  if (!acquired) throw new Error("Real PostgreSQL is required for native spreadsheet tests");
  shared = acquired;
  database = createDb(shared.appUrl);
  application = await createStandaloneEditableArtifactApplication({
    db: database.db,
    bus: new MemoryEventBus(),
    objectStorage: memoryObjects(),
  });
}, 180_000);

afterAll(async () => {
  application?.close();
  await database?.close();
  await shared?.release();
}, 60_000);

const SHEET_ID = "5a3f0e2d1c4b6a7980f1e2d3c4b5a697";

describe("native PostgreSQL spreadsheet transactions", () => {
  test("commits and replays multi-command batches in command order", async () => {
    const ctx = await fixture();
    const created = { kind: "created-in-batch", sheetId: SHEET_ID, createCommandIndex: 0 };
    // Same shape as an agent's first budget-sheet edit: create a sheet, fill
    // it, and size its columns in one atomic batch.
    const first = await apply(ctx, [
      { kind: "sheet.create", sheetId: SHEET_ID, name: "Offsite Budget", after: null },
      {
        kind: "cells.set",
        sheet: created,
        anchor: { row: 0, column: 0 },
        rows: 3,
        columns: 3,
        cells: ["Item", "Units", "Total", "Headcount", 14, { formula: "=B2*2" }, "Nights", 2, null],
      },
      ...widths(created),
    ]);
    expect(first.transaction).toMatchObject({ sequenceStart: 1, sequenceEnd: 5 });

    const [firstOperationIds] = await operationIdLists(ctx.artifact.id);
    expect(firstOperationIds).toHaveLength(5);
    const metadata = await inspect(ctx, {
      kind: "workbook-metadata",
      query: { maxSheets: 10, maxBytes: 16_000 },
    });
    // The sheet generation is named by command 0's operation identity, so the
    // list position is semantic and must never be re-sorted.
    const generationId = sheetsOf(metadata)[0]?.generationId;
    expect(generationId).toBe(firstOperationIds![0]);

    // Same shape as the follow-up edit: address the committed generation.
    const generation = { kind: "generation", sheetId: SHEET_ID, creationOperationId: generationId };
    await apply(ctx, [
      {
        kind: "cells.set",
        sheet: generation,
        anchor: { row: 3, column: 0 },
        rows: 1,
        columns: 2,
        cells: ["Dinners", 2],
      },
      ...widths(generation),
    ]);
    // Each batch is lexically ordered with probability 1/n!; keep committing
    // bounded batches until the unordered case has been exercised.
    for (let extra = 0; extra < 4 && !(await operationIdLists(ctx.artifact.id)).some(unordered);) {
      extra += 1;
      await apply(ctx, widths(generation, extra));
    }
    const lists = await operationIdLists(ctx.artifact.id);
    expect(lists.some(unordered)).toBe(true);

    // Operation facts occupy the exact sequence their identity's position names.
    const operations = await shared.admin<{ operation_id: string; sequence: number }[]>`
      select operation_id, sequence::int as sequence from editable_artifact_operations
      where artifact_id = ${ctx.artifact.id} order by sequence`;
    expect(operations.map((row) => row.operation_id)).toEqual(lists.flat());
    expect(operations.map((row) => row.sequence)).toEqual(
      lists.flat().map((_, index) => index + 1),
    );

    // A fresh read replays every committed transaction from durable history.
    const viewport = await inspect(ctx, {
      kind: "viewport",
      query: {
        sheetId: SHEET_ID,
        startRow: 0,
        startColumn: 0,
        rowCount: 4,
        columnCount: 3,
        maxCells: 12,
        maxBytes: 16_000,
      },
    });
    const cells = new Map(
      (viewport.projection as { projection: { cells: ViewportCell[] } }).projection.cells.map(
        (cell) => [`${cell.row}:${cell.column}`, cell],
      ),
    );
    expect(cells.get("1:1")?.value).toEqual({ kind: "number", value: 14 });
    expect(cells.get("1:2")?.formula).toContain("B2*2");
    expect(cells.get("3:0")?.value).toEqual({ kind: "text", value: "Dinners" });
    expect(viewport.artifact.headSequence).toBe(lists.flat().length);
  }, 60_000);
});

type ViewportCell = { row: number; column: number; value: unknown; formula: string | null };
type Fixture = Awaited<ReturnType<typeof fixture>>;

function widths(sheet: Record<string, unknown>, offset = 0) {
  return [310, 160, 290].map((width, column) => ({
    kind: "column.width.set",
    sheet,
    column,
    width: width + offset,
  }));
}

function unordered(ids: readonly string[]): boolean {
  return ids.some((id, index) => index > 0 && ids[index - 1]! >= id);
}

async function operationIdLists(artifactId: string): Promise<string[][]> {
  const rows = await shared.admin<{ operation_ids: string[] }[]>`
    select operation_ids from editable_artifact_transactions
    where artifact_id = ${artifactId} order by sequence_start`;
  return rows.map((row) => row.operation_ids);
}

function sheetsOf(result: Awaited<ReturnType<typeof inspect>>) {
  return (result.projection as { projection: { sheets: Array<{ generationId: string }> } })
    .projection.sheets;
}

async function apply(ctx: Fixture, commands: readonly unknown[]) {
  const artifact = await application.agent.get({
    ...ctx.context,
    artifactId: editableArtifactId(ctx.artifact.id),
  });
  // Like the MCP tool, every agent mutation authors from its own replica.
  const replicaId = editableArtifactReplicaId(
    `1${crypto.randomUUID().replaceAll("-", "").slice(0, 15)}`,
  );
  return await application.agent.apply({
    ...ctx.context,
    actor: { ...ctx.context.actor, replicaId },
    artifactId: editableArtifactId(ctx.artifact.id),
    expectedHeadSequence: artifact.headSequence,
    expectedStateHash: editableArtifactStateHash(artifact.stateHash),
    clientTransactionId: editableArtifactClientTransactionId(crypto.randomUUID()),
    batch: { modality: "spreadsheet", commands } as Parameters<
      typeof application.agent.apply
    >[0]["batch"],
  });
}

function inspect(ctx: Fixture, query: Record<string, unknown>) {
  return application.agent.inspect({
    ...ctx.context,
    artifactId: editableArtifactId(ctx.artifact.id),
    request: { modality: "spreadsheet", query } as Parameters<
      typeof application.agent.inspect
    >[0]["request"],
  });
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(database.db, {
    accountExternalSource: "native-spreadsheet",
    accountExternalId: suffix,
    accountName: "Spreadsheets",
    workspaceExternalSource: "native-spreadsheet",
    workspaceExternalId: suffix,
    workspaceName: "Spreadsheets",
    subjectId: `human:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = editableArtifactScope({
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
  });
  const session = await createSession(database.db, {
    ...scope,
    initialMessage: "Build a budget",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    firstPartyMcpPermissions: ["artifacts:read", "artifacts:publish"],
  });
  await initializeSessionStartAtomically(database.db, {
    ...scope,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(database.db, scope.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("Native spreadsheet fixture not claimed");
  const actor = {
    kind: "agent" as const,
    subjectId: "worker:native-spreadsheet",
    replicaId: editableArtifactReplicaId("2345678901abcdef"),
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    generation: claimed.turn.executionGeneration,
  };
  const context = { scope, actor, sessionId: session.id };
  const artifact = await application.agent.create({
    ...context,
    modality: "spreadsheet",
    title: "Offsite budget",
    idempotencyKey: editableArtifactClientTransactionId(crypto.randomUUID()),
  });
  return { context, artifact };
}

function memoryObjects(): ObjectStorage {
  const objects = new Map<string, { bytes: Uint8Array; head: ObjectHead }>();
  return {
    bucket: "native-spreadsheet-test",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    async headObject(key) {
      return objects.get(key)?.head ?? null;
    },
    async getObjectRange({ key, start, endInclusive, expectedVersionToken }) {
      const object = objects.get(key);
      if (!object) return null;
      if (expectedVersionToken !== object.head.VersionToken)
        throw new Error("Object version changed");
      return {
        bytes: object.bytes.slice(start, endInclusive + 1),
        versionToken: expectedVersionToken,
      };
    },
    async putObjectStreamIfAbsent(upload) {
      if (objects.has(upload.key)) return false;
      if (!upload.sha256) throw new Error("Content-addressed upload requires sha256");
      const chunks: Uint8Array[] = [];
      for await (const chunk of upload.chunks) chunks.push(chunk.slice());
      const bytes = Buffer.concat(chunks);
      objects.set(upload.key, {
        bytes,
        head: {
          ContentLength: bytes.byteLength,
          ContentType: upload.contentType,
          Metadata: { sha256: upload.sha256 },
          VersionToken: upload.sha256,
        },
      });
      return true;
    },
  } as ObjectStorage;
}
