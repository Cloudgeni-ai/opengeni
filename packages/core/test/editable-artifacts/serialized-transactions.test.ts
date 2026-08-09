import { describe, expect, test } from "bun:test";

import { decodeEditableArtifactSerializedCommit } from "@opengeni/contracts/editable-artifact-serialized-commit";
import { encodeDocumentArtifactCommandBatch } from "@opengeni/contracts/document-artifact-commands";

import {
  EditableArtifactIdempotencyConflictError,
  EditableArtifactInvalidRequestError,
  EditableArtifactKernelContractError,
  EditableArtifactSnapshotConflictError,
  EditableArtifactStaleBaseError,
} from "../../src/domain/editable-artifacts/errors";
import {
  editableArtifactCausalFrontier,
  editableArtifactContentHash,
  editableArtifactOperationId,
  editableArtifactSnapshotId,
  type EditableArtifactModality,
  type PublishEditableArtifactSnapshotRequest,
} from "../../src/domain/editable-artifacts/types";
import {
  artifactFixture,
  artifactId,
  editableArtifactTestCommandBytes,
  encodeSerializedTestReceipt,
  hash,
  humanActor,
  initialStateHash,
  scope,
  stableHex,
  transactionRequest,
} from "./fixtures";

type SerializedModality = Exclude<EditableArtifactModality, "spreadsheet">;

describe("authoritative serialized editable artifact transactions", () => {
  test.each(["document", "presentation"] as const)(
    "persists one exact OGAST/native receipt and one head step for %s",
    async (modality) => {
      const { service, store, kernel } = await artifactFixture({ modality });
      const request = await transactionRequest(service, {
        modality,
        clientTransactionId: `${modality}-one` as never,
      });

      const result = await service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request,
      });

      expect(result.replayed).toBe(false);
      expect(result.receipt).toMatchObject({
        modality,
        sequenceStart: 1,
        sequenceEnd: 1,
        priorNativeRevision: 0,
        nativeRevision: 1,
        commandCount: 1,
        priorStateHash: initialStateHash,
      });
      expect(await store.listOperations(scope, artifactId)).toEqual([]);
      const artifact = await store.getArtifact(scope, artifactId);
      expect(artifact).toMatchObject({
        modality,
        headSequence: 1,
        stateHash: result.receipt.stateHash,
      });
      expect("causalFrontier" in artifact!).toBe(false);

      const [committed] = await store.listCommittedTransactions(scope, artifactId);
      expect(committed).toMatchObject({
        modality,
        serverTransactionId: result.receipt.serverTransactionId,
        sequenceStart: 1,
        sequenceEnd: 1,
        priorNativeRevision: 0,
        nativeRevision: 1,
        commandCount: 1,
      });
      expect(committed!.modality).not.toBe("spreadsheet");
      if (committed!.modality === "spreadsheet") throw new Error("unreachable");
      const decoded = decodeEditableArtifactSerializedCommit(
        committed!.committedTransactionBytes,
        modality,
      );
      expect(decoded.transactionId).toBe(result.receipt.serverTransactionId);
      expect(decoded.intentBytes).toEqual(request.intentBytes);
      expect(decoded.requestHash).toBe(request.requestHash);
      expect(decoded.nativeReceiptBytes).toEqual(committed!.nativeReceiptBytes);
      expect(decoded.nativeReceipt.revision).toBe(1);
      expect(decoded.parentHeadSequence).toBe(0);
      expect(decoded.resultHeadSequence).toBe(1);
      expect(kernel.calls).toHaveLength(1);

      const outbox = (await store.listOutbox()).at(-1)!;
      expect(outbox.event).toMatchObject({
        kind: "transaction_committed",
        modality,
        sequenceStart: 1,
        sequenceEnd: 1,
        commitProtocolVersion: 1,
      });
      expect("operationProtocolVersion" in outbox.event).toBe(false);
    },
  );

  test.each(["document", "presentation"] as const)(
    "chains native revision and exact serialized predecessor for %s",
    async (modality) => {
      const { service, store, kernel } = await artifactFixture({ modality });
      const firstId = `${modality}-first` as never;
      const first = await transactionRequest(service, {
        modality,
        clientTransactionId: firstId,
      });
      await service.applyTransaction({ scope, artifactId, actor: humanActor, request: first });
      const second = await transactionRequest(service, {
        modality,
        clientTransactionId: `${modality}-second` as never,
        previousLocalTransactionId: firstId,
        replicaCounter: 2,
        observedHeadSequence: 1,
      });

      const applied = await service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: second,
      });

      expect(applied.receipt).toMatchObject({
        modality,
        sequenceStart: 2,
        sequenceEnd: 2,
        priorNativeRevision: 1,
        nativeRevision: 2,
      });
      expect(kernel.calls[1]!.state.committedTransactionTail).toHaveLength(1);
      const committed = (await store.listCommittedTransactions(scope, artifactId))[1]!;
      expect(committed.modality).toBe(modality);
      expect(
        decodeEditableArtifactSerializedCommit(committed.committedTransactionBytes, modality),
      ).toMatchObject({
        parentHeadSequence: 1,
        resultHeadSequence: 2,
        priorNativeRevision: 1,
      });
    },
  );

  test("replays exact serialized idempotency and rejects conflicting canonical truth", async () => {
    const { service, store, kernel } = await artifactFixture({ modality: "document" });
    const clientTransactionId = "document-replay" as never;
    const first = await transactionRequest(service, {
      modality: "document",
      clientTransactionId,
    });
    const applied = await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: first,
    });
    const replayed = await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: first,
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.receipt.receiptId).toBe(applied.receipt.receiptId);

    const conflicting = await transactionRequest(service, {
      modality: "document",
      clientTransactionId,
      commandBytes: encodeDocumentArtifactCommandBatch({
        version: 1,
        commands: [
          {
            kind: "document.flags.set",
            evenAndOddHeaders: false,
            trackRevisions: true,
          },
        ],
      }),
    });
    await expect(
      service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: conflicting,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactIdempotencyConflictError);
    expect(kernel.calls).toHaveLength(1);
    expect(await store.listReceipts(scope, artifactId)).toHaveLength(1);
  });

  test("rejects an exact-base race without rebasing or rerunning the loser", async () => {
    const { service, store, kernel } = await artifactFixture({ modality: "document" });
    let releaseKernel!: () => void;
    kernel.wait = new Promise<void>((resolve) => {
      releaseKernel = resolve;
    });
    const left = await transactionRequest(service, {
      modality: "document",
      clientTransactionId: "race-left" as never,
    });
    const right = await transactionRequest(service, {
      modality: "document",
      clientTransactionId: "race-right" as never,
    });
    const outcomes = [
      service.applyTransaction({ scope, artifactId, actor: humanActor, request: left }),
      service.applyTransaction({ scope, artifactId, actor: humanActor, request: right }),
    ];
    await waitUntil(() => kernel.calls.length === 2);
    releaseKernel();
    const settled = await Promise.allSettled(outcomes);

    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((item) => item.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "stale_base" },
    });
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      EditableArtifactStaleBaseError,
    );
    expect(kernel.calls).toHaveLength(2);
    expect(await store.listCommittedTransactions(scope, artifactId)).toHaveLength(1);
    expect((await store.getArtifact(scope, artifactId))!.headSequence).toBe(1);
  });

  test("rejects stale heads, CRDT metadata, empty batches, and cross-modality commands before native work", async () => {
    const cases = [
      await transactionRequest(undefined as never, {
        modality: "document",
        observedHeadSequence: 1,
      }),
      await transactionRequest(undefined as never, {
        modality: "document",
        causalBase: editableArtifactCausalFrontier([
          { replicaId: humanActor.replicaId, counter: 1 },
        ]),
      }),
      await transactionRequest(undefined as never, {
        modality: "document",
        selectiveUndoOperationIds: [editableArtifactOperationId(stableHex(0x55, 1))],
      }),
      await transactionRequest(undefined as never, {
        modality: "document",
        commandBytes: encodeDocumentArtifactCommandBatch({ version: 1, commands: [] }),
      }),
      await transactionRequest(undefined as never, {
        modality: "document",
        commandBytes: editableArtifactTestCommandBytes("presentation"),
      }),
    ];
    for (const [index, request] of cases.entries()) {
      const { service, kernel } = await artifactFixture({ modality: "document" });
      const failure = service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request,
      });
      if (index === 0) {
        await expect(failure).rejects.toBeInstanceOf(EditableArtifactStaleBaseError);
      } else {
        await expect(failure).rejects.toBeInstanceOf(EditableArtifactInvalidRequestError);
      }
      expect(kernel.calls).toHaveLength(0);
    }
  });

  test("enforces document no-op and presentation revision/state transitions", async () => {
    const document = await artifactFixture({ modality: "document" });
    document.kernel.corrupt = (result) => ({
      ...result,
      modality: "document",
      nativeReceiptBytes: encodeSerializedTestReceipt("document", 0, 1),
      resultingStateHash: initialStateHash,
    });
    const documentRequest = await transactionRequest(document.service, {
      modality: "document",
    });
    const noOp = await document.service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: documentRequest,
    });
    expect(noOp.receipt).toMatchObject({
      priorNativeRevision: 0,
      nativeRevision: 0,
      priorStateHash: initialStateHash,
      stateHash: initialStateHash,
    });

    const invalidDocument = await artifactFixture({ modality: "document" });
    invalidDocument.kernel.corrupt = (result) => ({
      ...result,
      modality: "document",
      nativeReceiptBytes: encodeSerializedTestReceipt("document", 0, 1),
      resultingStateHash: hash(999),
    });
    await expect(
      invalidDocument.service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: await transactionRequest(invalidDocument.service, {
          modality: "document",
        }),
      }),
    ).rejects.toBeInstanceOf(EditableArtifactKernelContractError);

    const presentation = await artifactFixture({ modality: "presentation" });
    presentation.kernel.corrupt = (result) => ({
      ...result,
      modality: "presentation",
      nativeReceiptBytes: encodeSerializedTestReceipt("presentation", 0, 1),
      resultingStateHash: initialStateHash,
    });
    await expect(
      presentation.service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: await transactionRequest(presentation.service, {
          modality: "presentation",
        }),
      }),
    ).rejects.toBeInstanceOf(EditableArtifactKernelContractError);
  });

  test("rejects a cross-modality or malformed native result without durable effects", async () => {
    for (const corrupt of [
      () => ({
        modality: "presentation" as const,
        nativeReceiptBytes: encodeSerializedTestReceipt("presentation", 1, 1),
        resultingStateHash: hash(701),
        kernelVersion: "test-kernel/1",
        modelSchemaVersion: 1,
      }),
      () => ({
        modality: "document" as const,
        nativeReceiptBytes: new Uint8Array([1, 2, 3]),
        resultingStateHash: hash(701),
        kernelVersion: "test-kernel/1",
        modelSchemaVersion: 1,
      }),
    ]) {
      const { service, store, kernel } = await artifactFixture({ modality: "document" });
      kernel.corrupt = corrupt;
      await expect(
        service.applyTransaction({
          scope,
          artifactId,
          actor: humanActor,
          request: await transactionRequest(service, { modality: "document" }),
        }),
      ).rejects.toBeInstanceOf(EditableArtifactKernelContractError);
      expect((await store.getArtifact(scope, artifactId))!.headSequence).toBe(0);
      expect(await store.listReceipts(scope, artifactId)).toHaveLength(0);
      expect(await store.listCommittedTransactions(scope, artifactId)).toHaveLength(0);
      expect(await store.listOutbox()).toHaveLength(0);
    }
  });

  test.each(["document", "presentation"] as const)(
    "publishes only the serialized checkpoint's exact native revision for %s",
    async (modality) => {
      const { service } = await artifactFixture({ modality });
      const applied = await service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: await transactionRequest(service, { modality }),
      });
      const exact = serializedSnapshot(modality, {
        counter: 1,
        headSequence: 1,
        nativeRevision: applied.receipt.nativeRevision,
        stateHash: applied.receipt.stateHash,
      });
      const wrong = serializedSnapshot(modality, {
        counter: 2,
        headSequence: 1,
        nativeRevision: applied.receipt.nativeRevision + 1,
        stateHash: applied.receipt.stateHash,
      });
      await expect(
        service.publishVerifiedSnapshot({
          scope,
          artifactId,
          actor: humanActor,
          snapshot: wrong,
        }),
      ).rejects.toBeInstanceOf(EditableArtifactSnapshotConflictError);
      const published = await service.publishVerifiedSnapshot({
        scope,
        artifactId,
        actor: humanActor,
        snapshot: exact,
      });
      expect(published.replayed).toBe(false);
      expect(published.snapshot).toMatchObject({
        modality,
        coveredHeadSequence: 1,
        nativeRevision: applied.receipt.nativeRevision,
      });
    },
  );

  test("test seeding checkpoints the supplied serialized native revision", async () => {
    // Use a dedicated fixture because this seam intentionally creates no blob.
    const fixture = await artifactFixture({ modality: "document", seed: false });
    await fixture.store.seedArtifact({
      scope,
      artifactId,
      modality: "document",
      title: "Imported document",
      stateHash: initialStateHash,
      nativeRevision: 7,
      createdAt: "2026-08-08T09:00:00.000Z",
    });
    const snapshot = serializedSnapshot("document", {
      counter: 7,
      headSequence: 0,
      nativeRevision: 7,
      stateHash: initialStateHash,
    });
    const published = await fixture.service.publishVerifiedSnapshot({
      scope,
      artifactId,
      actor: humanActor,
      snapshot,
    });
    expect(published.snapshot).toMatchObject({ nativeRevision: 7 });
  });
});

function serializedSnapshot(
  modality: SerializedModality,
  input: {
    counter: number;
    headSequence: number;
    nativeRevision: number;
    stateHash: ReturnType<typeof hash>;
  },
): PublishEditableArtifactSnapshotRequest {
  return Object.freeze({
    modality,
    snapshotId: editableArtifactSnapshotId(stableHex(0x77, input.counter)),
    blobReference: `blob:serialized-${modality}-${input.counter}`,
    byteSize: 1_024,
    contentHash: editableArtifactContentHash(hash(8_000 + input.counter)),
    mimeType: "application/vnd.opengeni.editable-artifact-snapshot",
    coveredHeadSequence: input.headSequence,
    nativeRevision: input.nativeRevision,
    stateHash: input.stateHash,
    modelSchemaVersion: 1,
    kernelVersion: "test-kernel/1",
    verifiedAt: "2026-08-08T09:59:00.000Z",
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for concurrent serialized kernels");
}
