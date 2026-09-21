import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
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
  setSessionGoalStatusWithEvent,
  withRlsContext,
  withSessionActivityRlsContext,
  withSessionActivitySavepoint,
  dbSql,
  PostgresEditableArtifactStore,
  type Database,
} from "@opengeni/db";
import { lockSessionEventWriteRows } from "../../../packages/db/src/session-control";
import {
  editableArtifactClientTransactionId,
  editableArtifactId,
  editableArtifactReplicaId,
  editableArtifactScope,
  editableArtifactStateHash,
} from "@opengeni/core/editable-artifacts";
import type { ObjectHead, ObjectStorage } from "@opengeni/storage";
import { createStandaloneEditableArtifactApplication } from "../src/editable-artifact-production";

let shared: SharedTestDatabase;
let database: ReturnType<typeof createDb>;
let application: Awaited<ReturnType<typeof createStandaloneEditableArtifactApplication>>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("native-report-delivery");
  if (!acquired) throw new Error("Real PostgreSQL is required for native report delivery tests");
  shared = acquired;
  database = createDb(shared.appUrl);
  // Deliberately no fake kernel/fallback: the configured native runtime is
  // byte-verified by the production composition and required by this suite.
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

function memoryObjects(): ObjectStorage {
  const objects = new Map<string, { bytes: Uint8Array; head: ObjectHead }>();
  return {
    bucket: "native-report-test",
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

async function fixture(withGoal = true) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(database.db, {
    accountExternalSource: "native-report",
    accountExternalId: suffix,
    accountName: "Reports",
    workspaceExternalSource: "native-report",
    workspaceExternalId: suffix,
    workspaceName: "Reports",
    subjectId: `human:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = editableArtifactScope({
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
  });
  const session = await createSession(database.db, {
    ...scope,
    initialMessage: "Write report",
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
    ...(withGoal
      ? {
          goal: { text: "Deliver report", reportRequirements: [{ id: "report", title: "Report" }] },
        }
      : {}),
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
  if (claimed.action !== "claimed") throw new Error("Native report fixture not claimed");
  const actor = {
    kind: "agent" as const,
    subjectId: "worker:native-report",
    replicaId: editableArtifactReplicaId("1234567890abcdef"),
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    generation: claimed.turn.executionGeneration,
  };
  const context = { scope, actor, sessionId: session.id };
  const artifact = await application.agent.create({
    ...context,
    modality: "document",
    title: "Report",
    idempotencyKey: editableArtifactClientTransactionId(crypto.randomUUID()),
  });
  return { grant, context, artifact };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function inspect(ctx: Fixture) {
  return application.agent.inspect({
    ...ctx.context,
    artifactId: editableArtifactId(ctx.artifact.id),
    request: {
      modality: "document",
      query: {
        kind: "body",
        startBlock: 0,
        limits: { maxItems: 100, maxTextUtf16: 10_000, maxTableCells: 100 },
      },
    },
  });
}
function complete(ctx: Fixture, inspectionReceiptId: string, db: Database = database.db) {
  const actor = ctx.context.actor;
  return setSessionGoalStatusWithEvent(db, ctx.context.scope.workspaceId, ctx.context.sessionId, {
    status: "completed",
    evidence: "Native document inspected and delivered",
    event: { type: "goal.completed", evidence: "Native document inspected and delivered" },
    reportArtifactActor: actor,
    commandActor: {
      type: "agent_attempt",
      sessionId: actor.sessionId,
      turnId: actor.turnId,
      attemptId: actor.attemptId,
      executionGeneration: actor.generation,
    },
    reportDeliveries: [
      { requirementId: "report", artifactId: ctx.artifact.id, inspectionReceiptId },
    ],
  });
}
async function waitForDatabaseLock() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await shared.admin`select count(*)::int as count from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
        and query like '%authorize_editable_artifact_actor%'`;
    if (row?.count > 0) return;
    await Bun.sleep(20);
  }
  throw new Error("Expected actual artifact authorization lock wait was not observed");
}

describe("native PostgreSQL report delivery", () => {
  test("ordinary read without a goal or goals permission records native body proof", async () => {
    const ctx = await fixture(false);
    await shared.admin`update sessions set first_party_mcp_permissions = '["artifacts:read"]'::jsonb where id = ${ctx.context.sessionId}`;
    const result = await inspect(ctx);
    expect(result.inspectionReceiptId).toBeString();
    expect(result.artifact.artifactReference).toContain(
      `/workspaces/${ctx.context.scope.workspaceId}/artifacts/editable/${ctx.artifact.id}`,
    );
    expect(result.projection).toBeDefined();
  }, 30_000);

  test("real native inspection completes against an exact head and proof survives direct deletion attempts", async () => {
    const ctx = await fixture();
    const result = await inspect(ctx);
    const receiptId = result.inspectionReceiptId!;
    await expect(
      withRlsContext(database.db, ctx.context.scope, (tx) =>
        tx.execute(dbSql`
      delete from session_command_receipts where id = ${receiptId}::uuid
    `),
      ),
    ).rejects.toMatchObject({
      cause: { code: "23514", message: expect.stringContaining("retained with their session") },
    });
    await expect(
      withRlsContext(database.db, ctx.context.scope, (tx) =>
        tx.execute(dbSql`
      update session_command_receipts set result = '{}'::jsonb where id = ${receiptId}::uuid
    `),
      ),
    ).rejects.toMatchObject({
      cause: { code: "23514", message: expect.stringContaining("immutable") },
    });
    expect((await complete(ctx, receiptId)).goal.status).toBe("completed");
    await shared.admin`delete from sessions where id = ${ctx.context.sessionId}`;
    const remaining =
      await shared.admin`select id from session_command_receipts where id = ${receiptId}`;
    expect(remaining).toHaveLength(0);
  }, 30_000);

  test("documents that application-role SQL insertion is trusted, not native execution attestation", async () => {
    const ctx = await fixture();
    const result = await inspect(ctx);
    const injectedId = crypto.randomUUID();
    // Deliberate SQL-writer authority, not an exposed tool/API. No fake GUC or
    // same-role function is presented as cryptographic provenance protection.
    await withRlsContext(database.db, ctx.context.scope, (tx) =>
      tx.execute(dbSql`
      insert into session_command_receipts
        (id, account_id, workspace_id, actor_type, actor_attempt_id, action,
         target_session_id, target_turn_id, operation_key, canonical_request_hash, result)
      select ${injectedId}::uuid, account_id, workspace_id, actor_type, actor_attempt_id, action,
        target_session_id, target_turn_id, ${injectedId}, canonical_request_hash, result
      from session_command_receipts where id = ${result.inspectionReceiptId!}::uuid
    `),
    );
    expect((await complete(ctx, injectedId)).goal.status).toBe("completed");
  }, 30_000);

  test("authorization revision changes invalidate previously native-inspected proof", async () => {
    const ctx = await fixture();
    const result = await inspect(ctx);
    const store = new PostgresEditableArtifactStore(database.db);
    await store.advanceAuthorizationRevision(ctx.context.scope, ctx.artifact.id, 1, 2);
    await expect(complete(ctx, result.inspectionReceiptId!)).rejects.toThrow("inspection receipt");
    expect((await complete(ctx, (await inspect(ctx)).inspectionReceiptId!)).goal.status).toBe(
      "completed",
    );
  }, 30_000);

  test("recipient revocation racing completion is observed under the membership lock", async () => {
    const ctx = await fixture();
    const result = await inspect(ctx);
    let completion: Promise<unknown> | undefined;
    let rejection: Promise<unknown> | undefined;
    await shared.admin.begin(async (tx) => {
      await tx`update workspace_memberships set permissions = '[]'::jsonb
        where workspace_id = ${ctx.context.scope.workspaceId} and subject_id = ${ctx.grant.subjectId}`;
      completion = complete(ctx, result.inspectionReceiptId!);
      rejection = completion.then(
        () => {
          throw new Error("Revoked recipient unexpectedly completed");
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain("recipient");
        },
      );
      await waitForDatabaseLock();
    });
    await rejection;
  }, 30_000);

  test("actual native artifact writer contention fails NOWAIT then permits retry after reinspection", async () => {
    const ctx = await fixture();
    const proof = await inspect(ctx);
    const ready = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const original = PostgresEditableArtifactStore.prototype.tryCommitAppliedTransaction;
    const hook = spyOn(
      PostgresEditableArtifactStore.prototype,
      "tryCommitAppliedTransaction",
    ).mockImplementation(async function (this: PostgresEditableArtifactStore, request) {
      if (request.artifactId === ctx.artifact.id) {
        ready.resolve();
        await proceed.promise;
      }
      return original.call(this, request);
    });
    // This executes the real native kernel and real optimistic writer; only the
    // scheduling barrier before that writer is injected for deterministic order.
    const writer = application.agent.apply({
      ...ctx.context,
      artifactId: editableArtifactId(ctx.artifact.id),
      expectedHeadSequence: ctx.artifact.headSequence,
      expectedStateHash: editableArtifactStateHash(ctx.artifact.stateHash),
      clientTransactionId: editableArtifactClientTransactionId(crypto.randomUUID()),
      batch: {
        modality: "document",
        commands: [{ kind: "document.flags.set", trackRevisions: true }],
      },
    });
    try {
      await Promise.race([
        ready.promise,
        writer.then(() => {
          throw new Error("Writer completed without the expected scheduling barrier");
        }),
      ]);
      await expect(
        withSessionActivityRlsContext(database.db, ctx.context.scope, (db) =>
          withSessionActivitySavepoint(db, async (tx) => {
            await lockSessionEventWriteRows(tx, {
              workspaceId: ctx.context.scope.workspaceId,
              controlLock: "share",
              sessionIds: [ctx.context.sessionId],
            });
            proceed.resolve();
            await waitForDatabaseLock();
            await complete(ctx, proof.inspectionReceiptId!, tx);
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: "55P03" } });
      await writer;
      await expect(complete(ctx, proof.inspectionReceiptId!)).rejects.toThrow("inspection receipt");
      expect((await complete(ctx, (await inspect(ctx)).inspectionReceiptId!)).goal.status).toBe(
        "completed",
      );
    } finally {
      proceed.resolve();
      hook.mockRestore();
      await writer.catch(() => undefined);
    }
  }, 30_000);
});
