import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { encodeDocumentArtifactCommandBatch } from "@opengeni/contracts/document-artifact-commands";
import { encodeEditableArtifactSerializedCommit } from "@opengeni/contracts/editable-artifact-serialized-commit";
import {
  encodeEditableArtifactMutationIntent,
  hashEditableArtifactMutationIntentBytes,
} from "@opengeni/contracts/editable-artifacts";
import { PostgresEditableArtifactStore } from "../src/editable-artifacts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  clearSessionGoal,
  getSessionGoal,
  initializeSessionStartAtomically,
  nestedPostgresSqlState,
  recordSessionGoalProgressWithEvent,
  recordNativeDocumentInspection,
  setSessionGoalStatusWithEvent,
  updateSessionGoalWithEvent,
  upsertSessionGoalWithEvent,
} from "../src";
import type { SessionGoalReportRequirement, SessionGoalReportDelivery } from "@opengeni/contracts";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("goal-report-requirements");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const direct = { id: "direct", title: "Direct report" };
const secondary = { id: "secondary", title: "Secondary report" };
const stateHash = `sha256:${"1".repeat(64)}`;

async function fixture(requirements: SessionGoalReportRequirement[] = [direct]) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "goal-reports",
    accountExternalId: suffix,
    accountName: "Reports",
    workspaceExternalSource: "goal-reports",
    workspaceExternalId: suffix,
    workspaceName: "Reports",
    subjectId: `human:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Write report",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: grant.subjectId },
  });
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: { text: "Write requested reports", reportRequirements: requirements },
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("Fixture turn was not claimed");
  const actor = {
    type: "agent_attempt" as const,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
  const artifactActor = {
    kind: "agent" as const,
    subjectId: "worker:first-party-mcp",
    replicaId: "0000000000000001",
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    generation: claimed.turn.executionGeneration,
  };
  return { grant, session, actor, artifactActor, started, turn: claimed.turn };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function scope(ctx: Fixture) {
  return { accountId: ctx.grant.accountId, workspaceId: ctx.grant.workspaceId };
}
function command(ctx: Fixture, operationKey = crypto.randomUUID()) {
  return { accountId: ctx.grant.accountId, actor: ctx.actor, operationKey };
}
function complete(ctx: Fixture, reportDeliveries?: SessionGoalReportDelivery[]) {
  return setSessionGoalStatusWithEvent(client.db, ctx.grant.workspaceId, ctx.session.id, {
    status: "completed",
    evidence: "Reports delivered",
    event: { type: "goal.completed", evidence: "Reports delivered" },
    commandActor: ctx.actor,
    reportArtifactActor: ctx.artifactActor,
    ...(reportDeliveries ? { reportDeliveries } : {}),
  });
}
function nextArtifactId() {
  return crypto.randomUUID().replaceAll("-", "");
}
function artifactHuman(ctx: Fixture) {
  return { kind: "human" as const, subjectId: ctx.grant.subjectId, replicaId: "9999999999999999" };
}
function pendingOutbox(now: string) {
  return {
    outboxId: nextArtifactId(),
    state: "pending" as const,
    attemptCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: now,
    lastErrorCode: null,
    publishedAt: null,
    deadLetteredAt: null,
    createdAt: now,
  };
}
async function artifact(ctx: Fixture, modality: "document" | "presentation" = "document") {
  const id = nextArtifactId();
  const snapshotId = nextArtifactId();
  const publishedAt = new Date().toISOString();
  // Match editable-artifacts-postgres.test.ts: creation atomically persists the
  // genesis snapshot, sequence-zero checkpoint, creation receipt and outbox.
  const created = await new PostgresEditableArtifactStore(client.db).createArtifact({
    scope: scope(ctx),
    artifactId: id,
    authorizationActor: artifactHuman(ctx),
    receiptId: nextArtifactId(),
    authorityKey: JSON.stringify(["human", ctx.grant.subjectId]),
    idempotencyKey: `create:${id}`,
    requestHash: stateHash,
    operationKind: "create",
    modality,
    title: "Report",
    expectedScopeAuthorizationRevision: 1,
    initialArtifactAuthorizationRevision: 1,
    createdBySubjectId: ctx.grant.subjectId,
    genesisSnapshot: {
      scope: scope(ctx),
      artifactId: id,
      modality,
      snapshotId,
      blobReference: `editable-artifacts/${id}/${snapshotId}`,
      byteSize: 256,
      contentHash: `sha256:${"f".repeat(64)}`,
      mimeType: "application/vnd.opengeni.editable-artifact-snapshot",
      coveredHeadSequence: 0,
      nativeRevision: 0,
      stateHash,
      modelSchemaVersion: 1,
      kernelVersion: "test-kernel-1",
      verifiedAt: publishedAt,
      publishedAt,
    },
    outbox: {
      ...pendingOutbox(publishedAt),
      event: {
        kind: "snapshot_published",
        schemaVersion: 1,
        scope: scope(ctx),
        artifactId: id,
        modality,
        snapshotId,
        coveredHeadSequence: 0,
        stateHash,
        publishedAt,
      },
    },
  });
  if (created.kind !== "result") throw new Error("Fixture artifact creation was not authorized");
  return created.value.artifact;
}

// The same canonical OGADR001 test receipt as the serialized transaction
// fixture in editable-artifacts-postgres.test.ts (one document.flags.set).
function documentNativeReceipt(revision: number) {
  const bytes = new Uint8Array(48);
  bytes.set(new TextEncoder().encode("OGADR001"));
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 1, true);
  view.setUint32(12, 1, true);
  view.setBigUint64(16, 16n, true);
  view.setBigUint64(24, BigInt(revision), true);
  view.setUint32(32, 1, true);
  let checksum = 0xcbf29ce484222325n;
  for (const byte of bytes.subarray(0, 40)) {
    checksum = BigInt.asUintN(64, (checksum ^ BigInt(byte)) * 0x100000001b3n);
  }
  view.setBigUint64(40, checksum, true);
  return bytes;
}

async function editDocument(
  ctx: Fixture,
  document: Awaited<ReturnType<typeof artifact>>,
  enabled: boolean,
) {
  if (document.modality !== "document") throw new Error("Expected a document fixture");
  const store = new PostgresEditableArtifactStore(client.db);
  const actorKey = JSON.stringify(["human", ctx.grant.subjectId]);
  const clientTransactionId = crypto.randomUUID();
  // Each fixture edit starts a fresh replica, so no local predecessor is claimed.
  const replicaId = nextArtifactId().slice(0, 16);
  const intentBytes = encodeEditableArtifactMutationIntent({
    envelopeVersion: 1,
    protocolVersion: 1,
    modelSchemaVersion: 1,
    commandProtocolVersion: 1,
    artifactId: document.id,
    clientTransactionId,
    replicaId,
    replicaCounter: 1,
    previousLocalTransactionId: null,
    observedHeadSequence: document.headSequence,
    causalBase: [],
    selectiveUndoOperationIds: [],
    commandBytes: encodeDocumentArtifactCommandBatch({
      version: 1,
      commands: [{ kind: "document.flags.set", evenAndOddHeaders: enabled, trackRevisions: null }],
    }),
  });
  const requestHash = hashEditableArtifactMutationIntentBytes(intentBytes);
  const serverTransactionId = nextArtifactId();
  const sequence = document.headSequence + 1;
  const nextStateHash = enabled ? `sha256:${"2".repeat(64)}` : stateHash;
  const nativeReceiptBytes = documentNativeReceipt(sequence);
  const committedAt = new Date().toISOString();
  const common = {
    scope: scope(ctx),
    artifactId: document.id,
    modality: "document" as const,
    serverTransactionId,
    requestHash,
    sequenceStart: sequence,
    sequenceEnd: sequence,
    priorStateHash: document.stateHash,
    stateHash: nextStateHash,
    commitProtocolVersion: 1 as const,
    priorNativeRevision: document.headSequence,
    nativeRevision: sequence,
    commandCount: 1,
    modelSchemaVersion: 1,
    kernelVersion: "test-kernel-1",
    committedAt,
  };
  const result = await store.tryCommitAppliedTransaction({
    scope: scope(ctx),
    artifactId: document.id,
    expectedLifecycle: "active",
    expectedAuthorizationRevision: document.authorizationRevision,
    authorizationActor: { ...artifactHuman(ctx), replicaId },
    actorKey,
    clientTransactionId,
    requestHash,
    expectedPredecessor: null,
    expectedUnclaimedUndoTargets: [],
    expectedHeadSequence: document.headSequence,
    serverTransactionId,
    receipt: {
      ...common,
      receiptId: nextArtifactId(),
      clientTransactionId,
      replicaId,
      replicaCounter: 1,
      previousLocalTransactionId: null,
      intentBytes,
      actorKey,
      intentEnvelopeVersion: 1,
      intentProtocolVersion: 1,
      commandProtocolVersion: 1,
    },
    committedTransaction: {
      ...common,
      nativeReceiptBytes,
      committedTransactionBytes: encodeEditableArtifactSerializedCommit({
        modality: "document",
        transactionId: serverTransactionId,
        parentHeadSequence: document.headSequence,
        resultHeadSequence: sequence,
        priorNativeRevision: document.headSequence,
        priorStateHash: document.stateHash,
        stateHash: nextStateHash,
        intentBytes,
        nativeReceiptBytes,
      }),
    },
    operations: [],
    outbox: {
      ...pendingOutbox(committedAt),
      event: {
        kind: "transaction_committed",
        schemaVersion: 1,
        scope: scope(ctx),
        artifactId: document.id,
        modality: "document",
        serverTransactionId,
        sequenceStart: sequence,
        sequenceEnd: sequence,
        stateHash: nextStateHash,
        commitProtocolVersion: 1,
        committedAt,
      },
    },
  });
  expect(result.kind).toBe("committed");
  const current = await store.readArtifactAtAuthorizationRevision(
    scope(ctx),
    document.id,
    document.authorizationRevision,
  );
  if (current.kind !== "result" || !current.artifact) {
    throw new Error("Committed document fixture is unavailable");
  }
  expect(current.artifact).toMatchObject({ headSequence: sequence, stateHash: nextStateHash });
  return current.artifact;
}
async function inspect(
  ctx: Fixture,
  document: Awaited<ReturnType<typeof artifact>>,
  queryKind = "body",
) {
  return recordNativeDocumentInspection(client.db, {
    scope: scope(ctx),
    actor: ctx.artifactActor,
    sessionId: ctx.session.id,
    artifact: document,
    queryHash: "a".repeat(64),
    queryKind,
  });
}
function delivery(artifactId: string, inspectionReceiptId: string, requirementId = direct.id) {
  return { requirementId, artifactId, inspectionReceiptId };
}

describe("persisted report requirements", () => {
  test("direct declaration is persisted and frozen at turn acceptance; omission cannot complete", async () => {
    const ctx = await fixture();
    expect(
      (await getSessionGoal(client.db, ctx.grant.workspaceId, ctx.session.id))?.reportRequirements,
    ).toEqual([direct]);
    expect(ctx.turn.goalSnapshot).toMatchObject({ reportRequirements: [direct] });
    await expect(complete(ctx)).rejects.toThrow("Every persisted report requirement");
    await expect(complete(ctx, [])).rejects.toThrow("Every persisted report requirement");
    expect((await getSessionGoal(client.db, ctx.grant.workspaceId, ctx.session.id))?.status).toBe(
      "active",
    );
  });
  test("secondary declarations are append-only, exact-replay safe and revision-neutral", async () => {
    const ctx = await fixture();
    const before = await getSessionGoal(client.db, ctx.grant.workspaceId, ctx.session.id);
    const input = {
      progressNote: "A secondary analysis needs a report",
      reportRequirements: [secondary],
      command: command(ctx),
    };
    const first = await recordSessionGoalProgressWithEvent(
      client.db,
      ctx.grant.workspaceId,
      ctx.session.id,
      input,
    );
    const replay = await recordSessionGoalProgressWithEvent(
      client.db,
      ctx.grant.workspaceId,
      ctx.session.id,
      input,
    );
    expect(first.goal.reportRequirements).toEqual([direct, secondary]);
    expect(first.goal.objectiveRevision).toBe(before!.objectiveRevision);
    expect(first.goal.version).toBe(before!.version);
    expect(replay).toMatchObject({
      replay: true,
      operationId: first.operationId,
      goal: first.goal,
      events: [],
    });
    await expect(
      recordSessionGoalProgressWithEvent(client.db, ctx.grant.workspaceId, ctx.session.id, {
        ...input,
        reportRequirements: [{ ...secondary, title: "Changed" }],
      }),
    ).rejects.toThrow();
    await expect(
      recordSessionGoalProgressWithEvent(client.db, ctx.grant.workspaceId, ctx.session.id, {
        ...input,
        command: command(ctx),
        reportRequirements: [direct, direct],
      }),
    ).rejects.toThrow();
    await expect(complete(ctx)).rejects.toThrow();
  });
  test("semantic update and low-level redirect cannot erase requirements", async () => {
    const ctx = await fixture();
    await updateSessionGoalWithEvent(client.db, ctx.grant.workspaceId, ctx.session.id, {
      text: "Refined report objective",
      changeKind: "refinement",
      rationale: "Clarify requested deliverable",
      expectedObjectiveRevision: 1,
      actor: "agent",
      command: command(ctx),
    });
    await upsertSessionGoalWithEvent(client.db, {
      ...scope(ctx),
      sessionId: ctx.session.id,
      text: "API redirect",
      reportRequirements: [],
      createdBy: "api",
      actor: "api",
    });
    expect(
      (await getSessionGoal(client.db, ctx.grant.workspaceId, ctx.session.id))?.reportRequirements,
    ).toEqual([direct]);
    // postgres.js Query is lazy: Bun's native-Promise matcher does not call its
    // overridden then(). Assimilate it first so the guarded SQL actually runs.
    await expect(
      Promise.resolve(
        shared.admin`update session_goals set metadata = '{}'::jsonb where session_id = ${ctx.session.id}`,
      ),
    ).rejects.toThrow("append-only");
    await expect(
      Promise.resolve(
        shared.admin`update session_goals set status = 'completed' where session_id = ${ctx.session.id}`,
      ),
    ).rejects.toThrow("Missing report deliveries");
  });
  test("non-report completion remains compatible", async () => {
    const ctx = await fixture([]);
    expect((await complete(ctx)).goal.status).toBe("completed");
    expect((await complete(ctx)).changed).toBe(false);
  });
  test("agent clear and old-writer deletion cannot erase pending reports; API cancellation remains supported", async () => {
    const ctx = await fixture();
    await expect(
      clearSessionGoal(client.db, ctx.grant.workspaceId, ctx.session.id, { actor: "agent" }),
    ).rejects.toThrow("cannot clear");
    await expect(
      Promise.resolve(shared.admin`delete from session_goals where session_id = ${ctx.session.id}`),
    ).rejects.toThrow("explicit API cancellation");
    expect(
      (await clearSessionGoal(client.db, ctx.grant.workspaceId, ctx.session.id, { actor: "api" }))
        .cleared,
    ).toBe(true);
  });
  test("body inspection gives stable immutable proof and completes only once", async () => {
    const ctx = await fixture();
    const doc = await artifact(ctx);
    const receipt = await inspect(ctx, doc);
    expect(await inspect(ctx, doc)).toBe(receipt);
    await expect(
      Promise.resolve(
        shared.admin`update session_command_receipts set result = '{}'::jsonb where id = ${receipt}`,
      ),
    ).rejects.toThrow("immutable");
    const result = await complete(ctx, [delivery(doc.id, receipt)]);
    expect(result.goal.status).toBe("completed");
    expect(result.events).toHaveLength(1);
    expect((await complete(ctx)).changed).toBe(false);
    await upsertSessionGoalWithEvent(client.db, {
      ...scope(ctx),
      sessionId: ctx.session.id,
      text: "New code-only task",
      createdBy: "agent",
      actor: "agent",
      commandActor: ctx.actor,
    });
    expect(
      (await getSessionGoal(client.db, ctx.grant.workspaceId, ctx.session.id))?.reportRequirements,
    ).toEqual([]);
  });
  test("summary-only, forged, cross-tenant, wrong modality and stale head proof fail", async () => {
    const ctx = await fixture();
    const doc = await artifact(ctx);
    const summary = await inspect(ctx, doc, "summary");
    await expect(complete(ctx, [delivery(doc.id, summary)])).rejects.toThrow("inspection receipt");
    await expect(complete(ctx, [delivery(doc.id, crypto.randomUUID())])).rejects.toThrow(
      "inspection receipt",
    );
    const other = await fixture();
    const otherDoc = await artifact(other);
    const otherReceipt = await inspect(other, otherDoc);
    await expect(complete(ctx, [delivery(otherDoc.id, otherReceipt)])).rejects.toThrow(
      "accessible",
    );
    const presentation = await artifact(ctx, "presentation");
    await expect(inspect(ctx, presentation)).rejects.toThrow("native document");
    const receipt = await inspect(ctx, doc);
    // Edit-then-undo still advances the sequence, even with the same state hash.
    const edited = await editDocument(ctx, doc, true);
    const undone = await editDocument(ctx, edited, false);
    expect(undone).toMatchObject({ headSequence: 2, stateHash: doc.stateHash });
    await expect(complete(ctx, [delivery(doc.id, receipt)])).rejects.toThrow("inspection receipt");
    await expect(inspect(ctx, doc)).rejects.toThrow("changed during inspection");
  });
  test("unknown and duplicate deliveries fail even with valid native proof", async () => {
    const ctx = await fixture();
    const doc = await artifact(ctx);
    const receipt = await inspect(ctx, doc);
    await expect(complete(ctx, [delivery(doc.id, receipt, "unknown")])).rejects.toThrow();
    await expect(
      complete(ctx, [delivery(doc.id, receipt), delivery(doc.id, receipt)]),
    ).rejects.toThrow();
  });
  test("archived artifact, revoked recipient and stale agent attempt fail before completion", async () => {
    const ctx = await fixture();
    const doc = await artifact(ctx);
    const receipt = await inspect(ctx, doc);
    await shared.admin`update editable_artifacts set lifecycle_state = 'archived' where id = ${doc.id}`;
    await expect(complete(ctx, [delivery(doc.id, receipt)])).rejects.toThrow("accessible");
    // Archive is terminal. Use a separately created active document to isolate
    // recipient revocation from the archived-artifact rejection above.
    const activeDoc = await artifact(ctx);
    const activeReceipt = await inspect(ctx, activeDoc);
    await shared.admin`update workspace_memberships set permissions = '[]'::jsonb where workspace_id = ${ctx.grant.workspaceId} and subject_id = ${ctx.grant.subjectId}`;
    await expect(complete(ctx, [delivery(activeDoc.id, activeReceipt)])).rejects.toThrow(
      "recipient",
    );
    await expect(
      complete(
        { ...ctx, actor: { ...ctx.actor, executionGeneration: ctx.actor.executionGeneration + 1 } },
        [delivery(activeDoc.id, activeReceipt)],
      ),
    ).rejects.toThrow();
    expect((await getSessionGoal(client.db, ctx.grant.workspaceId, ctx.session.id))?.status).toBe(
      "active",
    );
  });
  test("a concurrent artifact edit fails NOWAIT and rollback permits an exact retry", async () => {
    const ctx = await fixture();
    const doc = await artifact(ctx);
    const receipt = await inspect(ctx, doc);
    await shared.admin.begin(async (tx) => {
      await tx`select id from editable_artifacts where id = ${doc.id} for update`;
      // Drizzle wraps the PostgreSQL error; retain the exact NOWAIT SQLSTATE
      // assertion through the canonical cause-chain reader.
      await expect(
        complete(ctx, [delivery(doc.id, receipt)]).catch(nestedPostgresSqlState),
      ).resolves.toBe("55P03");
    });
    expect((await complete(ctx, [delivery(doc.id, receipt)])).goal.status).toBe("completed");
  });
  test("racing secondary declaration cannot be omitted by completion", async () => {
    const ctx = await fixture();
    const doc = await artifact(ctx);
    const receipt = await inspect(ctx, doc);
    const outcomes = await Promise.allSettled([
      recordSessionGoalProgressWithEvent(client.db, ctx.grant.workspaceId, ctx.session.id, {
        progressNote: "Secondary report discovered",
        reportRequirements: [secondary],
        command: command(ctx),
      }),
      complete(ctx, [delivery(doc.id, receipt)]),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const goal = await getSessionGoal(client.db, ctx.grant.workspaceId, ctx.session.id);
    if (goal!.status === "completed") expect(goal!.reportRequirements).toEqual([direct]);
    else expect(goal!.reportRequirements).toEqual([direct, secondary]);
  });
});
