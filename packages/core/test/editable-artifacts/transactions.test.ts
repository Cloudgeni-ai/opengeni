import { describe, expect, test } from "bun:test";
import { decodeCommittedTransactionSummary } from "@opengeni/contracts/editable-artifact-committed-transaction";
import {
  EditableArtifactDomainError,
  EditableArtifactCausalChainError,
  EditableArtifactIdempotencyConflictError,
  EditableArtifactKernelContractError,
  EditableArtifactNotEditableError,
  EditableArtifactNotFoundError,
  EditableArtifactRequestHashMismatchError,
  EditableArtifactRetryableConflictError,
} from "../../src/domain/editable-artifacts/errors";
import type { EditableArtifactSnapshotUnitOfWorkPort } from "../../src/domain/editable-artifacts/ports";
import { EDITABLE_ARTIFACT_MAX_OPERATION_BYTES_PER_TRANSACTION } from "../../src/domain/editable-artifacts/service";
import {
  editableArtifactCausalFrontier,
  editableArtifactClientTransactionId,
  editableArtifactReplicaId,
} from "../../src/domain/editable-artifacts/types";
import {
  artifactFixture,
  artifactId,
  encodeTestCommittedTransaction,
  humanActor,
  initialStateHash,
  otherHumanActor,
  otherScope,
  scope,
  transactionRequest,
  editableArtifactTestCommandBytes,
} from "./fixtures";

describe("authoritative editable artifact transactions", () => {
  test("atomically advances delivery head and causal frontier without conflating them", async () => {
    const { service, store, kernel } = await artifactFixture();
    const firstRequest = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-first"),
      commands: [{ code: "sheet.create" }, { code: "cell.set" }],
    });
    const first = await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: firstRequest,
    });
    expect(first.replayed).toBe(false);
    expect(first.receipt).toMatchObject({
      sequenceStart: 1,
      sequenceEnd: 2,
      operationCount: 2,
      operationProtocolVersion: 1,
    });
    const afterFirst = (await store.getArtifact(scope, artifactId))!;
    expect(afterFirst.headSequence).toBe(2);
    expect(afterFirst.causalFrontier).toEqual([{ replicaId: humanActor.replicaId, counter: 1 }]);

    const secondRequest = await transactionRequest(service, {
      actor: otherHumanActor,
      clientTransactionId: editableArtifactClientTransactionId("client-second"),
      observedHeadSequence: 2,
      causalBase: afterFirst.causalFrontier,
      commands: [{ code: "cell.set" }],
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: otherHumanActor,
      request: secondRequest,
    });
    const afterSecond = (await store.getArtifact(scope, artifactId))!;
    expect(afterSecond.headSequence).toBe(3);
    expect(afterSecond.causalFrontier).toEqual([
      { replicaId: humanActor.replicaId, counter: 1 },
      { replicaId: otherHumanActor.replicaId, counter: 1 },
    ]);
    expect(kernel.calls).toHaveLength(2);
    const operations = await store.listOperations(scope, artifactId);
    expect(operations).toHaveLength(3);
    expect(operations[0]!.dot).toEqual(operations[1]!.dot);
    const committed = await store.listCommittedTransactions(scope, artifactId);
    expect(committed).toHaveLength(2);
    expect(committed[0]).toMatchObject({
      serverTransactionId: first.receipt.serverTransactionId,
      requestHash: first.receipt.requestHash,
      priorStateHash: initialStateHash,
      operationIds: operations.slice(0, 2).map((item) => item.operationId),
    });
    expect(
      decodeCommittedTransactionSummary(committed[0]!.committedTransactionBytes).transactionId,
    ).toBe(first.receipt.serverTransactionId);
    expect((await store.listOutbox()).map((record) => record.event.kind)).toEqual([
      "transaction_committed",
      "transaction_committed",
    ]);
  });

  test("resolves an offline local predecessor without trusting a speculative authored base", async () => {
    const { service, store, kernel } = await artifactFixture();
    const first = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-chain-first"),
    });
    const second = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-chain-second"),
      replicaCounter: 2,
      previousLocalTransactionId: first.clientTransactionId,
      // The controller authored this while the predecessor was still pending.
      causalBase: editableArtifactCausalFrontier([]),
    });
    await expect(
      service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: second,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactCausalChainError);

    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: first,
    });
    const committed = await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: second,
    });
    expect(committed.receipt).toMatchObject({
      replicaId: humanActor.replicaId,
      replicaCounter: 2,
      previousLocalTransactionId: first.clientTransactionId,
      causalBase: [],
      resolvedCausalBase: [{ replicaId: humanActor.replicaId, counter: 1 }],
    });
    expect(kernel.calls[1]!.intent.causalBase).toEqual([]);
    expect(kernel.calls[1]!.resolvedCausalBase).toEqual([
      { replicaId: humanActor.replicaId, counter: 1 },
    ]);
    expect((await store.getArtifact(scope, artifactId))!.causalFrontier).toEqual([
      { replicaId: humanActor.replicaId, counter: 2 },
    ]);
  });

  test("inherits the predecessor's transitive causal dependencies without unrelated head state", async () => {
    const { service } = await artifactFixture();
    const remote = await transactionRequest(service, {
      actor: otherHumanActor,
      clientTransactionId: editableArtifactClientTransactionId("client-chain-remote"),
    });
    const remoteCommit = await service.applyTransaction({
      scope,
      artifactId,
      actor: otherHumanActor,
      request: remote,
    });
    const predecessor = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-chain-dependent"),
      observedHeadSequence: remoteCommit.receipt.sequenceEnd,
      causalBase: remoteCommit.receipt.resultingCausalFrontier,
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: predecessor,
    });
    const successor = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-chain-successor"),
      replicaCounter: 2,
      previousLocalTransactionId: predecessor.clientTransactionId,
      causalBase: editableArtifactCausalFrontier([]),
    });
    const committed = await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: successor,
    });
    expect(committed.receipt.resolvedCausalBase).toEqual([
      { replicaId: humanActor.replicaId, counter: 1 },
      { replicaId: otherHumanActor.replicaId, counter: 1 },
    ]);
  });

  test("replays one receipt for the same actor, client id, and request hash", async () => {
    const { service, store, kernel } = await artifactFixture();
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-replay"),
    });
    const [first, replay] = await Promise.all([
      service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request,
      }),
      service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request,
      }),
    ]);
    expect(first.receipt.receiptId).toBe(replay.receipt.receiptId);
    expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);
    expect(kernel.calls).toHaveLength(1);
    expect(await store.listReceipts(scope, artifactId)).toHaveLength(1);
    expect(await store.listOutbox()).toHaveLength(1);
  });

  test("conflicts when a client transaction id is reused for different canonical truth", async () => {
    const { service } = await artifactFixture();
    const clientTransactionId = editableArtifactClientTransactionId("client-collision");
    const first = await transactionRequest(service, {
      clientTransactionId,
      commands: [{ code: "cell.set", payload: { value: 1 } }],
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: first,
    });
    const second = await transactionRequest(service, {
      clientTransactionId,
      commands: [{ code: "cell.set", payload: { value: 2 } }],
    });
    expect(
      service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: second,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactIdempotencyConflictError);
  });

  test("serializes concurrent different hashes for one client id behind the durable winner", async () => {
    const { service, kernel, store } = await artifactFixture();
    let releaseKernel!: () => void;
    kernel.wait = new Promise<void>((resolve) => {
      releaseKernel = resolve;
    });
    const clientTransactionId = editableArtifactClientTransactionId("client-concurrent-collision");
    const firstRequest = await transactionRequest(service, {
      clientTransactionId,
      commands: [{ code: "cell.set", payload: { value: 1 } }],
    });
    const conflictingRequest = await transactionRequest(service, {
      clientTransactionId,
      commands: [{ code: "cell.set", payload: { value: 2 } }],
    });
    const first = service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: firstRequest,
    });
    await waitUntil(() => kernel.calls.length === 1);
    const conflicting = service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: conflictingRequest,
    });
    releaseKernel();
    await first;
    await expect(conflicting).rejects.toBeInstanceOf(EditableArtifactIdempotencyConflictError);
    expect(kernel.calls).toHaveLength(1);
    expect(await store.listReceipts(scope, artifactId)).toHaveLength(1);
  });

  test("rejects a caller-supplied hash that does not bind the exact request", async () => {
    const { service, kernel, store } = await artifactFixture();
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-bad-hash"),
    });
    const changedBytes = request.intentBytes.slice();
    const changedIndex = changedBytes.length - 1;
    changedBytes[changedIndex] = (changedBytes[changedIndex] ?? 0) ^ 1;
    const changed = { ...request, intentBytes: changedBytes };
    expect(
      service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: changed,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactRequestHashMismatchError);
    expect(kernel.calls).toHaveLength(0);
    expect((await store.getArtifact(scope, artifactId))!.headSequence).toBe(0);
  });

  test("copies untrusted opaque command bytes before the kernel boundary", async () => {
    const { service, kernel } = await artifactFixture();
    const commandBytes = editableArtifactTestCommandBytes("spreadsheet");
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-copy"),
      commandBytes,
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request,
    });
    const seen = kernel.calls[0]!.intent.commandBytes;
    expect([...seen]).toEqual([...commandBytes]);
    expect(seen).not.toBe(commandBytes);
    commandBytes[0] = 255;
    request.intentBytes[0] = 255;
    expect(seen[0]).not.toBe(255);
  });

  test("rolls back every durable effect when the authoritative kernel fails", async () => {
    const { service, store, kernel } = await artifactFixture();
    kernel.failure = new Error("kernel crashed");
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-kernel-failure"),
    });
    expect(
      service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request,
      }),
    ).rejects.toThrow("kernel crashed");
    expect((await store.getArtifact(scope, artifactId))!.headSequence).toBe(0);
    expect(await store.listReceipts(scope, artifactId)).toHaveLength(0);
    expect(await store.listOperations(scope, artifactId)).toHaveLength(0);
    expect(await store.listOutbox()).toHaveLength(0);
  });

  test("runs the expensive kernel outside the store's serialization path", async () => {
    const { service, store, kernel } = await artifactFixture();
    let releaseKernel!: () => void;
    kernel.wait = new Promise<void>((resolve) => {
      releaseKernel = resolve;
    });
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-off-lock-kernel"),
    });
    const pending = service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request,
    });
    await waitUntil(() => kernel.calls.length === 1);

    // A read completes while the kernel is intentionally suspended. The old
    // lock-scoped design would deadlock this assertion until releaseKernel().
    const duringKernel = await Promise.race([
      store.getArtifact(scope, artifactId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("artifact read remained locked by kernel")), 250),
      ),
    ]);
    expect(duringKernel?.headSequence).toBe(0);
    releaseKernel();
    await pending;
    expect((await store.getArtifact(scope, artifactId))!.headSequence).toBe(1);
  });

  test("discards a stale candidate and recomputes it from the winning head", async () => {
    const { service, store, kernel } = await artifactFixture();
    let releaseFirstKernel!: () => void;
    kernel.wait = new Promise<void>((resolve) => {
      releaseFirstKernel = resolve;
    });
    const firstRequest = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-stale-recompute-first"),
    });
    const first = service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: firstRequest,
    });
    await waitUntil(() => kernel.calls.length === 1);

    // Only the already-running first call retains this promise. The competing
    // replica can commit while it is suspended.
    kernel.wait = null;
    const competingRequest = await transactionRequest(service, {
      actor: otherHumanActor,
      clientTransactionId: editableArtifactClientTransactionId("client-stale-recompute-winner"),
    });
    const competing = await service.applyTransaction({
      scope,
      artifactId,
      actor: otherHumanActor,
      request: competingRequest,
    });
    expect(competing.receipt.sequenceEnd).toBe(1);

    releaseFirstKernel();
    const committed = await first;
    expect(committed.receipt.sequenceStart).toBe(2);
    const firstKernelCalls = kernel.calls.filter(
      (call) => call.intent.clientTransactionId === firstRequest.clientTransactionId,
    );
    expect(firstKernelCalls).toHaveLength(2);
    expect(firstKernelCalls[0]!.state.artifact.headSequence).toBe(0);
    expect(firstKernelCalls[1]!.state.artifact.headSequence).toBe(1);
    expect((await store.getArtifact(scope, artifactId))!.headSequence).toBe(2);
  });

  test("rejects a same-replica stale loser instead of renumbering its authored transaction", async () => {
    const { service, store, kernel } = await artifactFixture();
    let releaseFirstKernel!: () => void;
    kernel.wait = new Promise<void>((resolve) => {
      releaseFirstKernel = resolve;
    });
    const losingRequest = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-same-replica-loser"),
    });
    const losing = service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: losingRequest,
    });
    await waitUntil(() => kernel.calls.length === 1);

    kernel.wait = null;
    const winningRequest = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-same-replica-winner"),
    });
    await service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request: winningRequest,
    });
    releaseFirstKernel();
    await expect(losing).rejects.toBeInstanceOf(EditableArtifactCausalChainError);
    expect((await store.getArtifact(scope, artifactId))!.headSequence).toBe(1);
    expect(await store.listReceipts(scope, artifactId)).toHaveLength(1);
  });

  test("fails with a typed retryable error after bounded CAS contention", async () => {
    const { service, store, kernel } = await artifactFixture();
    let commitAttempts = 0;
    store.tryCommitAppliedTransaction = async () => {
      commitAttempts += 1;
      return Object.freeze({ kind: "stale" });
    };
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-bounded-contention"),
    });
    await expect(
      service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactRetryableConflictError);
    expect(commitAttempts).toBe(4);
    expect(kernel.calls).toHaveLength(4);
    expect((await store.getArtifact(scope, artifactId))!.headSequence).toBe(0);
  });

  test("fences a captured unit of work after its artifact lock exits", async () => {
    const { store } = await artifactFixture();
    let escaped: EditableArtifactSnapshotUnitOfWorkPort | undefined;
    await store.withSnapshotPublicationLock(scope, artifactId, async (unitOfWork) => {
      escaped = unitOfWork;
      expect(unitOfWork.artifact().headSequence).toBe(0);
    });
    expect(() => escaped!.artifact()).toThrow("no longer inside its lock");
  });

  test("rejects future delivery/causal observations but accepts stale concurrent bases", async () => {
    const { service, kernel } = await artifactFixture();
    const futureHead = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-future-head"),
      observedHeadSequence: 1,
    });
    await expectDomainCode(
      service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: futureHead,
      }),
      "causal_future",
    );
    const futureFrontier = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-future-vector"),
      causalBase: editableArtifactCausalFrontier([{ replicaId: humanActor.replicaId, counter: 1 }]),
    });
    await expectDomainCode(
      service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: futureFrontier,
      }),
      "causal_future",
    );
    expect(kernel.calls).toHaveLength(0);
  });

  test("enforces lifecycle, permissions, and tenant scope before canonical mutation", async () => {
    const archived = await artifactFixture({ lifecycle: "archived" });
    const request = await transactionRequest(archived.service, {
      clientTransactionId: editableArtifactClientTransactionId("client-archived"),
    });
    expect(
      archived.service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactNotEditableError);
    expect(archived.kernel.calls).toHaveLength(0);

    const denied = await artifactFixture();
    denied.authorization.deny("edit");
    const deniedRequest = await transactionRequest(denied.service, {
      clientTransactionId: editableArtifactClientTransactionId("client-denied"),
    });
    await expectDomainCode(
      denied.service.applyTransaction({
        scope,
        artifactId,
        actor: humanActor,
        request: deniedRequest,
      }),
      "forbidden",
    );
    expect(denied.kernel.calls).toHaveLength(0);

    const isolated = await artifactFixture();
    expect(
      isolated.service.getArtifact({
        scope: otherScope,
        artifactId,
        actor: humanActor,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactNotFoundError);
  });

  test("fences metadata reads when permission changes after authorization", async () => {
    const { service, store, authorization } = await artifactFixture();
    const read = store.readArtifactAtAuthorizationRevision.bind(store);
    let first = true;
    store.readArtifactAtAuthorizationRevision = async (...args) => {
      if (first) {
        first = false;
        await store.advanceAuthorizationRevision(scope, artifactId, 1, 2);
        authorization.setRevision(2);
        authorization.deny("read");
      }
      return read(...args);
    };
    await expectDomainCode(
      service.getArtifact({ scope, artifactId, actor: humanActor }),
      "forbidden",
    );
    expect(authorization.calls.filter((call) => call.permission === "read")).toHaveLength(2);
  });

  test("cannot commit native work after edit permission is revoked", async () => {
    const { service, store, authorization, kernel } = await artifactFixture();
    let releaseKernel!: () => void;
    kernel.wait = new Promise<void>((resolve) => {
      releaseKernel = resolve;
    });
    const request = await transactionRequest(service, {
      clientTransactionId: editableArtifactClientTransactionId("client-revoked-during-kernel"),
    });
    const pending = service.applyTransaction({
      scope,
      artifactId,
      actor: humanActor,
      request,
    });
    await waitUntil(() => kernel.calls.length === 1);
    await store.advanceAuthorizationRevision(scope, artifactId, 1, 2);
    authorization.setRevision(2);
    authorization.deny("edit");
    releaseKernel();

    await expectDomainCode(pending, "forbidden");
    expect((await store.getArtifact(scope, artifactId))!.headSequence).toBe(0);
    expect(await store.listOutbox()).toHaveLength(0);
    expect(kernel.calls).toHaveLength(1);
  });
});

describe("authoritative kernel contract fencing", () => {
  test("rejects mismatched transaction dots, wrong replicas, frontiers, ids, and bytes", async () => {
    const corruptions = [
      (result: any) => ({
        ...result,
        committedTransactionBytes: rewriteCommitted(result, {
          dot: {
            ...decodeCommittedTransactionSummary(result.committedTransactionBytes).dot,
            counter: 2,
          },
          resultingCausalFrontier: [{ replicaId: humanActor.replicaId, counter: 2 }],
        }),
      }),
      (result: any) => ({
        ...result,
        committedTransactionBytes: rewriteCommitted(result, {
          dot: {
            replicaId: editableArtifactReplicaId("0000000000000003"),
            counter: 1,
          },
        }),
      }),
      (result: any) => ({
        ...result,
        committedTransactionBytes: rewriteCommitted(result, {
          resultingCausalFrontier: [],
        }),
      }),
      (result: any) => ({
        ...result,
        committedTransactionBytes: rewriteCommitted(result, {
          operationIds: [
            decodeCommittedTransactionSummary(result.committedTransactionBytes).operationIds[0],
            decodeCommittedTransactionSummary(result.committedTransactionBytes).operationIds[0],
          ],
        }),
      }),
      (result: any) => ({
        ...result,
        committedTransactionBytes: new Uint8Array(
          EDITABLE_ARTIFACT_MAX_OPERATION_BYTES_PER_TRANSACTION + 1,
        ),
      }),
    ] as const;

    for (const [index, corrupt] of corruptions.entries()) {
      const { service, kernel, store } = await artifactFixture();
      kernel.corrupt = corrupt;
      const request = await transactionRequest(service, {
        clientTransactionId: editableArtifactClientTransactionId(`client-corrupt-${index}`),
      });
      expect(
        service.applyTransaction({
          scope,
          artifactId,
          actor: humanActor,
          request,
        }),
      ).rejects.toBeInstanceOf(EditableArtifactKernelContractError);
      expect((await store.getArtifact(scope, artifactId))!.headSequence).toBe(0);
      expect(await store.listOutbox()).toHaveLength(0);
      expect(await store.listReceipts(scope, artifactId)).toHaveLength(0);
      expect(await store.listOperations(scope, artifactId)).toHaveLength(0);
      expect(await store.listCommittedTransactions(scope, artifactId)).toHaveLength(0);
    }
  });
});

function rewriteCommitted(
  result: { committedTransactionBytes: Uint8Array },
  overrides: Partial<
    Omit<ReturnType<typeof decodeCommittedTransactionSummary>, "operationProtocolVersion">
  >,
): Uint8Array {
  const summary = decodeCommittedTransactionSummary(result.committedTransactionBytes);
  return encodeTestCommittedTransaction({
    transactionId: overrides.transactionId ?? summary.transactionId,
    dot: overrides.dot ?? summary.dot,
    resolvedCausalBase: overrides.resolvedCausalBase ?? summary.resolvedCausalBase,
    operationIds: overrides.operationIds ?? summary.operationIds,
    priorStateHash: overrides.priorStateHash ?? summary.priorStateHash,
    resultingCausalFrontier: overrides.resultingCausalFrontier ?? summary.resultingCausalFrontier,
    stateHash: overrides.stateHash ?? summary.stateHash,
  });
}

async function expectDomainCode(
  promise: Promise<unknown>,
  code: EditableArtifactDomainError["code"],
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected domain failure");
  } catch (error) {
    expect(error).toBeInstanceOf(EditableArtifactDomainError);
    expect((error as EditableArtifactDomainError).code).toBe(code);
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition");
}
