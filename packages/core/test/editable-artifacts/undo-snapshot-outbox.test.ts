import { describe, expect, test } from "bun:test";
import { EDITABLE_ARTIFACT_COMPACTION_TRANSACTION_THRESHOLD } from "../../src/domain/editable-artifacts/service";
import {
  EditableArtifactOutboxLeaseConflictError,
  EditableArtifactSnapshotConflictError,
  EditableArtifactUndoTargetError,
} from "../../src/domain/editable-artifacts/errors";
import {
  editableArtifactCausalFrontier,
  editableArtifactClientTransactionId,
  editableArtifactOperationId,
  editableArtifactReplicaId,
  editableArtifactSnapshotId,
} from "../../src/domain/editable-artifacts/types";
import {
  artifactFixture,
  artifactId,
  hash,
  humanActor,
  initialStateHash,
  otherHumanActor,
  scope,
  snapshotRequest,
  stableHex,
  TestArtifactCompaction,
  transactionRequest,
} from "./fixtures";

describe("selective editable artifact undo", () => {
  test("targets the author's exact committed operation once", async () => {
    const { service, store, kernel } = await artifactFixture();
    const originalRequest = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-original"),
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: originalRequest,
    });
    const original = (await store.listOperations(scope, artifactId))[0]!;
    const artifact = (await store.getArtifact(scope, artifactId))!;
    const undoRequest = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-undo"),
      observedHeadSequence: artifact.headSequence,
      causalBase: artifact.causalFrontier,
      previousLocalTransactionId: originalRequest.clientTransactionId,
      commands: [],
      selectiveUndoOperationIds: [original.operationId],
    });
    const undo = await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: undoRequest,
    });
    expect(undo.receipt.selectiveUndoOperationIds).toEqual([original.operationId]);
    expect(kernel.calls[1]!.resolvedUndoTargets.map((operation) => operation.operationId)).toEqual([
      original.operationId,
    ]);

    const newer = (await store.getArtifact(scope, artifactId))!;
    const duplicateUndo = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-undo-again"),
      observedHeadSequence: newer.headSequence,
      causalBase: newer.causalFrontier,
      previousLocalTransactionId: undoRequest.clientTransactionId,
      commands: [],
      selectiveUndoOperationIds: [original.operationId],
    });
    await expect(
      service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: duplicateUndo,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactUndoTargetError);
  });

  test("rejects another authority, unknown targets, and duplicate targets", async () => {
    const { service, store } = await artifactFixture();
    const originalRequest = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-owner"),
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: originalRequest,
    });
    const operation = (await store.listOperations(scope, artifactId))[0]!;
    const state = (await store.getArtifact(scope, artifactId))!;

    const foreignUndo = await transactionRequest(service, {
      actor: otherHumanActor,
      clientTransactionId: editableArtifactClientTransactionId("client-foreign-undo"),
      observedHeadSequence: state.headSequence,
      causalBase: state.causalFrontier,
      commands: [],
      selectiveUndoOperationIds: [operation.operationId],
    });
    await expect(
      service.applyTransaction({
        scope,
        artifactId,
        actor: otherHumanActor,
        request: foreignUndo,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactUndoTargetError);

    const unknownUndo = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-unknown-undo"),
      replicaCounter: 2,
      previousLocalTransactionId: originalRequest.clientTransactionId,
      observedHeadSequence: state.headSequence,
      causalBase: state.causalFrontier,
      commands: [],
      selectiveUndoOperationIds: [editableArtifactOperationId(stableHex(9, 999))],
    });
    await expect(
      service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: unknownUndo,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactUndoTargetError);
    await expect(
      transactionRequest(service, {
        clientTransactionId: editableArtifactClientTransactionId("client-duplicate-target"),
        selectiveUndoOperationIds: [operation.operationId, operation.operationId],
      }),
    ).rejects.toThrow("duplicate selective undo operation id");
  });

  test("requires a same-authority undo to causally observe its target", async () => {
    const { service, store } = await artifactFixture();
    const originalRequest = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-causal-undo-owner"),
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: originalRequest,
    });
    const operation = (await store.listOperations(scope, artifactId))[0]!;
    const sameHumanOtherReplica = Object.freeze({
      ...humanActor,
      replicaId: editableArtifactReplicaId("0000000000000003"),
    });
    const concurrentUndo = await transactionRequest(service, {
      actor: sameHumanOtherReplica,
      clientTransactionId: editableArtifactClientTransactionId("client-causal-undo-concurrent"),
      causalBase: editableArtifactCausalFrontier([]),
      commands: [],
      selectiveUndoOperationIds: [operation.operationId],
    });
    await expect(
      service.applyTransaction({
        scope,
        artifactId,
        actor: sameHumanOtherReplica,
        request: concurrentUndo,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactUndoTargetError);
  });

  test("allows exactly one concurrent selective-undo claimant", async () => {
    const { service, store, kernel } = await artifactFixture();
    const originalRequest = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-concurrent-undo-original"),
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: originalRequest,
    });
    const operation = (await store.listOperations(scope, artifactId))[0]!;
    const state = (await store.getArtifact(scope, artifactId))!;
    const firstReplica = Object.freeze({
      ...humanActor,
      replicaId: editableArtifactReplicaId("0000000000000003"),
    });
    const secondReplica = Object.freeze({
      ...humanActor,
      replicaId: editableArtifactReplicaId("0000000000000004"),
    });

    let releaseFirstKernel!: () => void;
    kernel.wait = new Promise<void>((resolve) => {
      releaseFirstKernel = resolve;
    });
    const losingRequest = await transactionRequest(service, {
      actor: firstReplica,
      clientTransactionId: editableArtifactClientTransactionId("client-concurrent-undo-loser"),
      observedHeadSequence: state.headSequence,
      causalBase: state.causalFrontier,
      commands: [],
      selectiveUndoOperationIds: [operation.operationId],
    });
    const losing = service.applyTransaction({
      scope,
      artifactId,
      actor: firstReplica,
      request: losingRequest,
    });
    await waitUntil(() => kernel.calls.length === 2);

    kernel.wait = null;
    const winningRequest = await transactionRequest(service, {
      actor: secondReplica,
      clientTransactionId: editableArtifactClientTransactionId("client-concurrent-undo-winner"),
      observedHeadSequence: state.headSequence,
      causalBase: state.causalFrontier,
      commands: [],
      selectiveUndoOperationIds: [operation.operationId],
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: secondReplica,
      request: winningRequest,
    });
    releaseFirstKernel();
    await expect(losing).rejects.toBeInstanceOf(EditableArtifactUndoTargetError);
    expect(await store.listReceipts(scope, artifactId)).toHaveLength(2);
  });
});

describe("verified snapshot publication", () => {
  test("compacts exact durable head with read authority and trims future replay", async () => {
    const compaction = new TestArtifactCompaction();
    const { service, store, authorization, kernel } = await artifactFixture({ compaction });
    await service.publishVerifiedSnapshot({
      scope,
      artifactId,
      actor: humanActor,
      snapshot: snapshotRequest({
        coveredHeadSequence: 0,
        coveredCausalFrontier: editableArtifactCausalFrontier([]),
        stateHash: initialStateHash,
      }),
    });
    const first = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-before-compaction"),
    });
    await service.applyTransaction({ scope, artifactId, actor: humanActor, request: first });
    authorization.deny("manage");
    authorization.calls.length = 0;

    const compacted = await service.compactCurrentHead({ scope, artifactId, actor: humanActor });
    expect(compacted.coveredHeadSequence).toBe(1);
    expect(compaction.calls).toHaveLength(1);
    expect(authorization.calls.map((call) => call.permission)).toEqual(["read"]);
    expect((await store.getArtifact(scope, artifactId))!.currentSnapshotId).toBe(
      compacted.snapshotId,
    );

    const state = (await store.getArtifact(scope, artifactId))!;
    if (state.modality !== "spreadsheet") throw new Error("expected spreadsheet fixture");
    const next = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-after-compaction"),
      observedHeadSequence: state.headSequence,
      causalBase: state.causalFrontier,
      previousLocalTransactionId: first.clientTransactionId,
    });
    await service.applyTransaction({ scope, artifactId, actor: humanActor, request: next });
    expect(kernel.calls.at(-1)!.state.snapshot?.snapshotId).toBe(compacted.snapshotId);
    expect(kernel.calls.at(-1)!.state.committedTransactionTail).toHaveLength(0);
  });

  test("coalesces concurrent exact-head compaction without guessing by content", async () => {
    const compaction = new TestArtifactCompaction();
    const { service } = await artifactFixture({ compaction });
    await service.publishVerifiedSnapshot({
      scope,
      artifactId,
      actor: humanActor,
      snapshot: snapshotRequest({
        coveredHeadSequence: 0,
        coveredCausalFrontier: editableArtifactCausalFrontier([]),
        stateHash: initialStateHash,
      }),
    });
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-coalesced-compaction"),
    });
    await service.applyTransaction({ scope, artifactId, actor: humanActor, request });
    let release!: () => void;
    compaction.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = service.compactCurrentHead({ scope, artifactId, actor: humanActor });
    await waitUntil(() => compaction.calls.length === 1);
    const second = service.compactCurrentHead({ scope, artifactId, actor: humanActor });
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(left.snapshotId).toBe(right.snapshotId);
    expect(compaction.calls).toHaveLength(1);
  });

  test("authorizes every caller before sharing in-flight compaction", async () => {
    const compaction = new TestArtifactCompaction();
    const { service, authorization } = await artifactFixture({ compaction });
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-authenticated-compaction"),
    });
    await service.applyTransaction({ scope, artifactId, actor: humanActor, request });
    let release!: () => void;
    compaction.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorized = service.compactCurrentHead({ scope, artifactId, actor: humanActor });
    await waitUntil(() => compaction.calls.length === 1);
    authorization.denySubject(otherHumanActor.subjectId, "read");

    await expect(
      service.compactCurrentHead({ scope, artifactId, actor: otherHumanActor }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(compaction.calls).toHaveLength(1);

    release();
    await authorized;
  });

  test("concurrent authorized actors converge on one exact snapshot", async () => {
    const compaction = new TestArtifactCompaction();
    const { service } = await artifactFixture({ compaction });
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-multi-actor-compaction"),
    });
    await service.applyTransaction({ scope, artifactId, actor: humanActor, request });
    let release!: () => void;
    compaction.wait = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = service.compactCurrentHead({ scope, artifactId, actor: humanActor });
    const second = service.compactCurrentHead({ scope, artifactId, actor: otherHumanActor });
    await waitUntil(() => compaction.calls.length === 2);
    release();
    const [left, right] = await Promise.all([first, second]);

    expect(left.snapshotId).toBe(right.snapshotId);
    expect(left.coveredHeadSequence).toBe(1);
    expect(compaction.calls).toHaveLength(2);
  });

  test("rebuilds when an edit advances the head during compaction", async () => {
    const compaction = new TestArtifactCompaction();
    const { service, store } = await artifactFixture({ compaction });
    const firstRequest = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-compaction-race-first"),
    });
    await service.applyTransaction({ scope, artifactId, actor: humanActor, request: firstRequest });
    let release!: () => void;
    compaction.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = service.compactCurrentHead({ scope, artifactId, actor: humanActor });
    await waitUntil(() => compaction.calls.length === 1);

    compaction.wait = null;
    const state = (await store.getArtifact(scope, artifactId))!;
    if (state.modality !== "spreadsheet") throw new Error("expected spreadsheet fixture");
    const secondRequest = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-compaction-race-second"),
      observedHeadSequence: state.headSequence,
      causalBase: state.causalFrontier,
      previousLocalTransactionId: firstRequest.clientTransactionId,
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: secondRequest,
    });
    release();

    const compacted = await pending;
    expect(compacted.coveredHeadSequence).toBe(2);
    expect(compaction.calls).toHaveLength(2);
    expect((await store.getArtifact(scope, artifactId))?.currentSnapshotId).toBe(
      compacted.snapshotId,
    );
  });

  test("compacts before another edit when replay work reaches the soft ceiling", async () => {
    const compaction = new TestArtifactCompaction();
    const { service, store, kernel, authorization } = await artifactFixture({ compaction });
    await service.publishVerifiedSnapshot({
      scope,
      artifactId,
      actor: humanActor,
      snapshot: snapshotRequest({
        coveredHeadSequence: 0,
        coveredCausalFrontier: editableArtifactCausalFrontier([]),
        stateHash: initialStateHash,
      }),
    });
    const first = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-soft-limit-base"),
    });
    await service.applyTransaction({ scope, artifactId, actor: humanActor, request: first });
    const state = (await store.getArtifact(scope, artifactId))!;
    if (state.modality !== "spreadsheet") throw new Error("expected spreadsheet fixture");
    const readBasis = store.readTransactionBasis.bind(store);
    let injectSoftLimit = true;
    store.readTransactionBasis = async (...args) => {
      const result = await readBasis(...args);
      if (!injectSoftLimit || result.kind !== "basis") return result;
      injectSoftLimit = false;
      return Object.freeze({
        ...result,
        kernelState: Object.freeze({
          ...result.kernelState,
          tailTransactionCount: EDITABLE_ARTIFACT_COMPACTION_TRANSACTION_THRESHOLD,
        }),
      });
    };
    const next = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-soft-limit-next"),
      observedHeadSequence: state.headSequence,
      causalBase: state.causalFrontier,
      previousLocalTransactionId: first.clientTransactionId,
    });
    authorization.deny("read");
    await service.applyTransaction({ scope, artifactId, actor: humanActor, request: next });

    expect(compaction.calls).toHaveLength(1);
    expect(authorization.calls.at(-1)?.permission).toBe("edit");
    expect(kernel.calls).toHaveLength(2);
    expect(kernel.calls[1]!.state.tailTransactionCount).toBe(0);
    expect(kernel.calls[1]!.state.committedTransactionTail).toHaveLength(0);
  });

  test("cannot publish a verified snapshot after manage permission is revoked", async () => {
    const { service, store, authorization, snapshotVerifier } = await artifactFixture();
    let releaseVerification!: () => void;
    snapshotVerifier.wait = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const candidate = snapshotRequest({
      coveredHeadSequence: 0,
      coveredCausalFrontier: editableArtifactCausalFrontier([]),
      stateHash: initialStateHash,
    });
    const pending = service.publishVerifiedSnapshot({
      scope,
      artifactId,
      actor: humanActor,
      snapshot: candidate,
    });
    await waitUntil(() => snapshotVerifier.calls.length === 1);
    await store.advanceAuthorizationRevision(scope, artifactId, 1, 2);
    authorization.setRevision(2);
    authorization.deny("manage");
    releaseVerification();

    await expect(pending).rejects.toMatchObject({ code: "forbidden" });
    expect(await store.listSnapshots(scope, artifactId)).toHaveLength(0);
    expect(await store.listOutbox()).toHaveLength(0);
  });

  test("publishes a checked transaction boundary and trims the next kernel tail", async () => {
    const { service, store, kernel, clock } = await artifactFixture();
    const firstRequest = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-snapshot-base"),
      commands: [{ code: "sheet.create" }, { code: "cell.set" }],
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: firstRequest,
    });
    const state = (await store.getArtifact(scope, artifactId))!;
    clock.advance(1000);
    const candidate = snapshotRequest({
      coveredHeadSequence: state.headSequence,
      coveredCausalFrontier: state.causalFrontier,
      stateHash: state.stateHash,
    });
    const published = await service.publishVerifiedSnapshot({
      scope,
      artifactId,
      actor: humanActor,
      snapshot: candidate,
    });
    expect(published.replayed).toBe(false);
    expect((await store.getArtifact(scope, artifactId))!.currentSnapshotId).toBe(
      candidate.snapshotId,
    );

    const replay = await service.publishVerifiedSnapshot({
      scope,
      artifactId,
      actor: humanActor,
      snapshot: candidate,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot.publishedAt).toBe(published.snapshot.publishedAt);
    expect(await store.listSnapshots(scope, artifactId)).toHaveLength(1);

    const nextState = (await store.getArtifact(scope, artifactId))!;
    const nextRequest = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-after-snapshot"),
      observedHeadSequence: nextState.headSequence,
      causalBase: nextState.causalFrontier,
      previousLocalTransactionId: firstRequest.clientTransactionId,
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: nextRequest,
    });
    expect(kernel.calls[1]!.state.snapshot?.snapshotId).toBe(candidate.snapshotId);
    expect(kernel.calls[1]!.state.committedTransactionTail).toHaveLength(0);
    expect((await store.listOutbox()).map((record) => record.event.kind)).toEqual([
      "transaction_committed",
      "snapshot_published",
      "transaction_committed",
    ]);
  });

  test("keeps metadata time monotonic when a snapshot advances during off-lock kernel work", async () => {
    const { service, store, clock } = await artifactFixture();
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-snapshot-pointer-race"),
    });
    const candidate = snapshotRequest({
      coveredHeadSequence: 0,
      coveredCausalFrontier: editableArtifactCausalFrontier([]),
      stateHash: initialStateHash,
    });
    const commit = store.tryCommitAppliedTransaction.bind(store);
    let snapshotPublishedAt: string | undefined;
    store.tryCommitAppliedTransaction = async (input) => {
      if (!snapshotPublishedAt) {
        clock.advance(1_000);
        const published = await service.publishVerifiedSnapshot({
          scope,
          artifactId,
          actor: humanActor,
          snapshot: candidate,
        });
        snapshotPublishedAt = published.snapshot.publishedAt;
      }
      return commit(input);
    };

    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request,
    });
    const artifact = (await store.getArtifact(scope, artifactId))!;
    expect(artifact.currentSnapshotId).toBe(candidate.snapshotId);
    expect(artifact.headSequence).toBe(1);
    expect(artifact.updatedAt).toBe(snapshotPublishedAt);
  });

  test("allows a verified older boundary before any snapshot, then only forward coverage", async () => {
    const { service, store } = await artifactFixture();
    const first = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-checkpoint-one"),
    });
    const firstReceipt = await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: first,
    });
    const firstState = (await store.getArtifact(scope, artifactId))!;
    const second = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-checkpoint-two"),
      observedHeadSequence: firstState.headSequence,
      causalBase: firstState.causalFrontier,
      previousLocalTransactionId: first.clientTransactionId,
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: second,
    });
    const older = snapshotRequest({
      coveredHeadSequence: firstReceipt.receipt.sequenceEnd,
      coveredCausalFrontier: firstReceipt.receipt.resultingCausalFrontier,
      stateHash: firstReceipt.receipt.stateHash,
    });
    await service.publishVerifiedSnapshot({
      scope,
      artifactId,
      actor: humanActor,
      snapshot: older,
    });
    expect((await store.getArtifact(scope, artifactId))!.headSequence).toBe(2);

    const staleDifferentId = {
      ...older,
      snapshotId: editableArtifactSnapshotId(stableHex(4, 99)),
      blobReference: "blob:stale-copy",
    };
    await expect(
      service.publishVerifiedSnapshot({
        scope,
        artifactId,
        actor: humanActor,
        snapshot: staleDifferentId,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactSnapshotConflictError);
  });

  test("rejects non-boundaries, incorrect state/frontier, and snapshot-id mutation", async () => {
    const { service, store } = await artifactFixture();
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-two-operation-boundary"),
      commands: [{ code: "sheet.create" }, { code: "cell.set" }],
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request,
    });
    const state = (await store.getArtifact(scope, artifactId))!;
    const nonBoundary = snapshotRequest({
      coveredHeadSequence: 1,
      coveredCausalFrontier: editableArtifactCausalFrontier([
        { replicaId: humanActor.replicaId, counter: 1 },
      ]),
      stateHash: hash(123),
    });
    await expect(
      service.publishVerifiedSnapshot({
        scope,
        artifactId,
        actor: humanActor,
        snapshot: nonBoundary,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactSnapshotConflictError);

    const valid = snapshotRequest({
      snapshotCounter: 2,
      coveredHeadSequence: state.headSequence,
      coveredCausalFrontier: state.causalFrontier,
      stateHash: state.stateHash,
    });
    await service.publishVerifiedSnapshot({
      scope,
      artifactId,
      actor: humanActor,
      snapshot: valid,
    });
    await expect(
      service.publishVerifiedSnapshot({
        scope,
        artifactId,
        actor: humanActor,
        snapshot: { ...valid, byteSize: valid.byteSize + 1 },
      }),
    ).rejects.toBeInstanceOf(EditableArtifactSnapshotConflictError);
  });

  test("rejects snapshot accessors without evaluating them", async () => {
    const { service } = await artifactFixture();
    const candidate = snapshotRequest({
      coveredHeadSequence: 0,
      coveredCausalFrontier: editableArtifactCausalFrontier([]),
      stateHash: hash(1),
    });
    let getterCalled = false;
    const accessor = { ...candidate } as Record<string, unknown>;
    Object.defineProperty(accessor, "byteSize", {
      enumerable: true,
      get() {
        getterCalled = true;
        return getterCalled ? -999 : candidate.byteSize;
      },
    });
    await expect(
      service.publishVerifiedSnapshot({
        scope,
        artifactId,
        actor: humanActor,
        snapshot: accessor as never,
      }),
    ).rejects.toThrow("Accessor property");
    expect(getterCalled).toBe(false);
  });

  test("cannot publish metadata when authoritative blob verification fails", async () => {
    const { service, store, snapshotVerifier } = await artifactFixture();
    snapshotVerifier.failure = new Error("snapshot bytes do not match metadata");
    const candidate = snapshotRequest({
      coveredHeadSequence: 0,
      coveredCausalFrontier: editableArtifactCausalFrontier([]),
      stateHash: hash(1),
    });
    await expect(
      service.publishVerifiedSnapshot({
        scope,
        artifactId,
        actor: humanActor,
        snapshot: candidate,
      }),
    ).rejects.toThrow("snapshot bytes do not match metadata");
    expect(await store.listSnapshots(scope, artifactId)).toHaveLength(0);
    expect((await store.getArtifact(scope, artifactId))!.currentSnapshotId).toBeNull();
  });
});

describe("durable live outbox contract", () => {
  test("leases, retries after expiry, fences stale publishers, releases, and settles idempotently", async () => {
    const { service, store, clock } = await artifactFixture();
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-outbox"),
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request,
    });
    const firstClaim = await store.claimLiveOutbox({
      owner: "publisher-a",
      leaseDurationMs: 1000,
      limit: 10,
    });
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]).toMatchObject({
      state: "publishing",
      attemptCount: 1,
    });
    expect(firstClaim[0]!.event).not.toHaveProperty("operations");
    expect(
      await store.claimLiveOutbox({
        owner: "publisher-b",
        leaseDurationMs: 1000,
        limit: 10,
      }),
    ).toHaveLength(0);

    clock.advance(1001);
    const reclaimed = await store.claimLiveOutbox({
      owner: "publisher-a",
      leaseDurationMs: 1000,
      limit: 10,
    });
    expect(reclaimed[0]).toMatchObject({
      state: "publishing",
      attemptCount: 2,
    });
    await expect(
      store.markLiveOutboxPublished({
        outboxId: firstClaim[0]!.outboxId,
        owner: "publisher-a",
        attemptCount: firstClaim[0]!.attemptCount,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactOutboxLeaseConflictError);

    await store.releaseLiveOutbox({
      outboxId: reclaimed[0]!.outboxId,
      owner: "publisher-a",
      attemptCount: reclaimed[0]!.attemptCount,
    });
    await store.releaseLiveOutbox({
      outboxId: reclaimed[0]!.outboxId,
      owner: "publisher-a",
      attemptCount: reclaimed[0]!.attemptCount,
    });
    const finalClaim = await store.claimLiveOutbox({
      owner: "publisher-c",
      leaseDurationMs: 1000,
      limit: 1,
    });
    expect(finalClaim[0]!.attemptCount).toBe(3);
    await store.markLiveOutboxPublished({
      outboxId: finalClaim[0]!.outboxId,
      owner: "publisher-c",
      attemptCount: finalClaim[0]!.attemptCount,
    });
    await store.releaseLiveOutbox({
      outboxId: finalClaim[0]!.outboxId,
      owner: "publisher-c",
      attemptCount: finalClaim[0]!.attemptCount,
    });
    await expect(
      store.markLiveOutboxPublished({
        outboxId: firstClaim[0]!.outboxId,
        owner: "publisher-a",
        attemptCount: firstClaim[0]!.attemptCount,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactOutboxLeaseConflictError);
    await expect(
      store.releaseLiveOutbox({
        outboxId: firstClaim[0]!.outboxId,
        owner: "publisher-a",
        attemptCount: firstClaim[0]!.attemptCount,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactOutboxLeaseConflictError);
    await store.markLiveOutboxPublished({
      outboxId: finalClaim[0]!.outboxId,
      owner: "publisher-c",
      attemptCount: finalClaim[0]!.attemptCount,
    });
    expect(
      await store.claimLiveOutbox({
        owner: "publisher-d",
        leaseDurationMs: 1000,
        limit: 10,
      }),
    ).toHaveLength(0);
    expect((await store.listOutbox())[0]).toMatchObject({
      state: "published",
      attemptCount: 3,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  test("returns immutable copies so a publisher cannot alter durable truth", async () => {
    const { service, store } = await artifactFixture();
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-immutable-outbox"),
    });
    const result = await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request,
    });
    const committed = (await store.listCommittedTransactions(scope, artifactId))[0]!;
    committed.committedTransactionBytes[0] = 255;
    expect(
      (await store.listCommittedTransactions(scope, artifactId))[0]!.committedTransactionBytes[0],
    ).not.toBe(255);
    const receipt = (await store.listReceipts(scope, artifactId))[0]!;
    receipt.intentBytes[0] = 255;
    expect((await store.listReceipts(scope, artifactId))[0]!.intentBytes[0]).not.toBe(255);
    expect(Object.isFrozen(receipt.selectiveUndoOperationIds)).toBe(true);
    const claimed = (
      await store.claimLiveOutbox({
        owner: "publisher",
        leaseDurationMs: 1000,
        limit: 1,
      })
    )[0]!;
    expect(Object.isFrozen(claimed)).toBe(true);
    expect(Object.isFrozen(claimed.event)).toBe(true);
    expect(Object.isFrozen(result.receipt)).toBe(true);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition");
}
