import { describe, expect, test } from "bun:test";
import { EDITABLE_ARTIFACT_INTENT_MAX_BYTES } from "@opengeni/contracts/editable-artifacts";
import { IDBFactory } from "fake-indexeddb";
import {
  EditableArtifactStorageConflictError,
  IndexedDbEditableArtifactStorage,
  MemoryEditableArtifactStorage,
  type EditableArtifactStorageScope,
} from "../../src/editable-artifacts/storage";
import type {
  EditableArtifactCommittedTransaction,
  EditableArtifactPendingTransaction,
  EditableArtifactSpreadsheetCommittedTransaction,
  EditableArtifactSpreadsheetPendingTransaction,
  EditableArtifactSpreadsheetSnapshot,
  EditableArtifactStoredReplica,
} from "../../src/editable-artifacts/types";
import {
  testCommand,
  testCommitted,
  testPending,
  testStableId,
  testStateHash,
} from "./protocol-fixtures";

const ARTIFACT_ID = "10000000000000010000000000000001";
const REPLICA_ID = "0000000000000001";
const SCOPE: EditableArtifactStorageScope = {
  namespace: "account-1/workspace-1/principal-1",
  artifactId: ARTIFACT_ID,
  modality: "spreadsheet",
};

type SpreadsheetStoredReplica = EditableArtifactStoredReplica & {
  modality: "spreadsheet";
  snapshot: EditableArtifactSpreadsheetSnapshot;
  tail: EditableArtifactSpreadsheetCommittedTransaction[];
};

function committed(
  startSequence: number,
  endSequence: number,
  stateHash: string,
  _byte = endSequence,
): EditableArtifactSpreadsheetCommittedTransaction {
  return testCommitted({
    artifactId: ARTIFACT_ID,
    transactionId: `committed-${startSequence}`,
    requestHash: testStateHash(`request-${startSequence}`),
    startSequence,
    endSequence,
    priorStateHash: state(startSequence - 1),
    stateHash,
    causalFrontier: [{ replicaId: REPLICA_ID, counter: endSequence }],
    protocolVersion: 1,
  });
}

function state(sequence: number): string {
  return testStateHash(`state-${sequence}`);
}

function replica(): SpreadsheetStoredReplica {
  return {
    artifactId: ARTIFACT_ID,
    modality: "spreadsheet",
    snapshot: {
      modality: "spreadsheet",
      artifactId: ARTIFACT_ID,
      sequence: 2,
      stateHash: state(2),
      causalFrontier: [{ replicaId: REPLICA_ID, counter: 2 }],
      digest: testStateHash("digest-2"),
      protocolVersion: 1,
      kernelVersion: "kernel-1",
      modelSchemaVersion: 1,
      bytes: new Uint8Array([1, 2]),
    },
    tail: [committed(3, 4, state(4), 4), committed(5, 5, state(5), 5)],
    cursor: 5,
    stateHash: state(5),
    updatedAt: 100,
  };
}

function pending(
  transactionId: string,
  createdAt: number,
  requestHash = `hash-${transactionId}`,
): EditableArtifactSpreadsheetPendingTransaction {
  const seed = new TextEncoder().encode(requestHash);
  return testPending({
    artifactId: ARTIFACT_ID,
    clientTransactionId: transactionId,
    protocolVersion: 1,
    modelSchemaVersion: 1,
    commandVersion: 1,
    replicaId: REPLICA_ID,
    replicaCounter: createdAt,
    previousLocalTransactionId: null,
    observedHeadSequence: 5,
    causalBase: [{ replicaId: REPLICA_ID, counter: 5 }],
    selectiveUndoTargets: [],
    commandBytes: testCommand(seed),
    createdAt,
  });
}

function spreadsheetCommitted(
  value: EditableArtifactCommittedTransaction,
): EditableArtifactSpreadsheetCommittedTransaction {
  if (value.modality !== "spreadsheet") throw new TypeError("expected spreadsheet commit");
  return value;
}

function spreadsheetPending(
  value: EditableArtifactPendingTransaction,
): EditableArtifactSpreadsheetPendingTransaction {
  if (value.modality !== "spreadsheet") throw new TypeError("expected spreadsheet pending");
  return value;
}

describe("MemoryEditableArtifactStorage", () => {
  test("retains a reconstructible snapshot and tail without sharing mutable bytes", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const source = replica();
    const expectedFirstCommitted = source.tail[0]!.committedTransactionBytes.slice();
    const expectedSecondCommitted = source.tail[1]!.committedTransactionBytes.slice();
    await storage.saveReplica(SCOPE, source, null);

    source.snapshot.bytes[0] = 99;
    source.tail[0]!.committedTransactionBytes[0] = 99;
    (source.tail[0]!.causalFrontier[0] as { counter: number }).counter = 99;

    const first = await storage.loadReplica(SCOPE);
    expect(first?.snapshot.bytes).toEqual(new Uint8Array([1, 2]));
    expect(first?.tail[0]?.committedTransactionBytes).toEqual(expectedFirstCommitted);
    expect(spreadsheetCommitted(first!.tail[0]!).causalFrontier).toEqual([
      { replicaId: REPLICA_ID, counter: 4 },
    ]);

    first!.snapshot.bytes[1] = 88;
    first!.tail[1]!.committedTransactionBytes[0] = 88;
    const second = await storage.loadReplica(SCOPE);
    expect(second?.snapshot.bytes).toEqual(new Uint8Array([1, 2]));
    expect(second?.tail[1]?.committedTransactionBytes).toEqual(expectedSecondCommitted);

    await storage.clearReplica(SCOPE);
    expect(await storage.loadReplica(SCOPE)).toBeNull();
  });

  test("rejects state that cannot reconstruct its retained cursor", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const invalid = replica();
    invalid.tail[1] = committed(6, 6, state(6));
    invalid.cursor = 6;
    invalid.stateHash = state(6);

    await expect(storage.saveReplica(SCOPE, invalid, null)).rejects.toThrow(
      "committed tail must be contiguous",
    );
  });

  test("atomically accepts an authoritative full resync replacement", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const current = replica();
    await storage.saveReplica(SCOPE, current, null);

    const replacement = replica();
    replacement.tail = [];
    replacement.cursor = 2;
    replacement.stateHash = state(2);
    await storage.saveReplica(SCOPE, replacement, {
      cursor: current.cursor,
      stateHash: current.stateHash,
    });

    expect(await storage.loadReplica(SCOPE)).toMatchObject({
      cursor: 2,
      stateHash: state(2),
      tail: [],
    });
    await expect(
      storage.appendCommitted(SCOPE, {
        artifactId: ARTIFACT_ID,
        expectedCursor: 5,
        expectedStateHash: state(5),
        transaction: committed(6, 6, state(6)),
        updatedAt: 101,
      }),
    ).rejects.toBeInstanceOf(EditableArtifactStorageConflictError);
    expect((await storage.loadReplica(SCOPE))?.stateHash).toBe(state(2));
  });

  test("compacts a retained tail even when the authoritative head is unchanged", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const current = replica();
    await storage.saveReplica(SCOPE, current, null);
    const compacted = replica();
    compacted.snapshot = {
      ...compacted.snapshot,
      sequence: 5,
      stateHash: state(5),
      causalFrontier: [{ replicaId: REPLICA_ID, counter: 5 }],
      digest: testStateHash("digest-5"),
      bytes: new Uint8Array([5]),
    };
    compacted.tail = [];

    await storage.saveReplica(SCOPE, compacted, {
      cursor: current.cursor,
      stateHash: current.stateHash,
    });

    expect(await storage.loadReplica(SCOPE)).toMatchObject({
      snapshot: { sequence: 5 },
      cursor: 5,
      stateHash: state(5),
      tail: [],
    });
  });

  test("does not let a stale snapshot replacement clobber another tab's newer head", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const current = replica();
    await storage.saveReplica(SCOPE, current, null);
    await storage.appendCommitted(SCOPE, {
      artifactId: ARTIFACT_ID,
      expectedCursor: 5,
      expectedStateHash: state(5),
      transaction: committed(6, 6, state(6), 6),
      updatedAt: 101,
    });
    const staleReplacement = replica();
    staleReplacement.tail = [];
    staleReplacement.cursor = 2;
    staleReplacement.stateHash = state(2);

    await expect(
      storage.saveReplica(SCOPE, staleReplacement, {
        cursor: 5,
        stateHash: state(5),
      }),
    ).rejects.toBeInstanceOf(EditableArtifactStorageConflictError);
    expect(await storage.loadReplica(SCOPE)).toMatchObject({
      cursor: 6,
      stateHash: state(6),
    });
  });

  test("appends committed state with an exact constant-time head CAS", async () => {
    const storage = new MemoryEditableArtifactStorage();
    await storage.saveReplica(SCOPE, replica(), null);
    const transaction = committed(6, 7, state(7), 7);
    const expectedCommittedBytes = transaction.committedTransactionBytes.slice();

    await storage.appendCommitted(SCOPE, {
      artifactId: ARTIFACT_ID,
      expectedCursor: 5,
      expectedStateHash: state(5),
      transaction,
      updatedAt: 101,
    });
    transaction.committedTransactionBytes[0] = 99;
    (transaction.causalFrontier[0] as { counter: number }).counter = 99;

    const stored = await storage.loadReplica(SCOPE);
    expect(stored).toMatchObject({ cursor: 7, stateHash: state(7), updatedAt: 101 });
    expect(stored?.tail).toHaveLength(3);
    expect(stored?.tail[2]?.committedTransactionBytes).toEqual(expectedCommittedBytes);
    expect(spreadsheetCommitted(stored!.tail[2]!).causalFrontier).toEqual([
      { replicaId: REPLICA_ID, counter: 7 },
    ]);
  });

  test("allows exactly one concurrent append from the same expected head", async () => {
    const storage = new MemoryEditableArtifactStorage();
    await storage.saveReplica(SCOPE, replica(), null);
    const append = (transaction: EditableArtifactCommittedTransaction) =>
      storage.appendCommitted(SCOPE, {
        artifactId: ARTIFACT_ID,
        expectedCursor: 5,
        expectedStateHash: state(5),
        transaction,
        updatedAt: 102,
      });
    const competing = testCommitted({
      artifactId: ARTIFACT_ID,
      transactionId: testStableId("competing"),
      startSequence: 6,
      endSequence: 6,
      priorStateHash: state(5),
      stateHash: testStateHash("competing-state"),
      causalFrontier: [{ replicaId: REPLICA_ID, counter: 6 }],
    });

    const results = await Promise.allSettled([
      append(committed(6, 6, state(6), 6)),
      append(competing),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(
      EditableArtifactStorageConflictError,
    );
    expect(await storage.loadReplica(SCOPE)).toMatchObject({
      cursor: 6,
      stateHash: state(6),
    });
  });

  test("accepts the same committed append idempotently across concurrent tabs", async () => {
    const storage = new MemoryEditableArtifactStorage();
    await storage.saveReplica(SCOPE, replica(), null);
    const transaction = committed(6, 6, state(6), 6);
    const append = () =>
      storage.appendCommitted(SCOPE, {
        artifactId: ARTIFACT_ID,
        expectedCursor: 5,
        expectedStateHash: state(5),
        transaction,
        updatedAt: 102,
      });

    const results = await Promise.allSettled([append(), append()]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await storage.loadReplica(SCOPE))?.tail).toHaveLength(3);
  });

  test("retains idempotent pending transactions in deterministic order", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const later = pending("b", 20);
    const sameTimeLaterId = pending("c", 10);
    const first = pending("a", 10);
    await storage.putPending(SCOPE, later);
    await storage.putPending(SCOPE, sameTimeLaterId);
    await storage.putPending(SCOPE, first);
    await storage.putPending(SCOPE, first);

    first.commandBytes[0] = 99;
    (first.causalBase[0] as { counter: number }).counter = 99;
    const listed = await storage.listPending(SCOPE);
    expect(listed.map((value) => value.clientTransactionId)).toEqual(["a", "c", "b"]);
    const firstCommandBytes = pending("a", 10).commandBytes;
    expect(listed[0]?.commandBytes).toEqual(firstCommandBytes);
    expect(spreadsheetPending(listed[0]!).causalBase).toEqual([
      { replicaId: REPLICA_ID, counter: 5 },
    ]);

    listed[0]!.commandBytes[0] = 88;
    expect((await storage.listPending(SCOPE))[0]?.commandBytes).toEqual(firstCommandBytes);
  });

  test("fails before the durable pending transaction count can exceed its hard bound", async () => {
    const storage = new MemoryEditableArtifactStorage();
    for (let index = 1; index <= 1_024; index += 1) {
      await storage.putPending(SCOPE, pending(`transaction-${index}`, index));
    }

    await expect(storage.putPending(SCOPE, pending("transaction-overflow", 1_025))).rejects.toThrow(
      "pending transaction store exceeds its count bound",
    );
    expect(await storage.listPending(SCOPE)).toHaveLength(1_024);
  });

  test("uses the shared protocol ceiling for durable intent bytes", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const accepted = pending("intent-at-limit", 1);
    await storage.putPending(SCOPE, accepted);

    const rejected = pending("intent-over-limit", 2);
    rejected.intentBytes = new Uint8Array(EDITABLE_ARTIFACT_INTENT_MAX_BYTES + 1);
    await expect(storage.putPending(SCOPE, rejected)).rejects.toThrow(
      "intentBytes exceeds its hard byte bound",
    );
  });

  test("fails closed on idempotency-key reuse and preserves pending edits on resync", async () => {
    const storage = new MemoryEditableArtifactStorage();
    await storage.saveReplica(SCOPE, replica(), null);
    const original = pending("transaction", 10, "original-hash");
    await storage.putPending(SCOPE, original);

    await expect(
      storage.putPending(SCOPE, pending("transaction", 11, "different-hash")),
    ).rejects.toBeInstanceOf(EditableArtifactStorageConflictError);
    const sameHashDifferentBytes = pending("transaction", 10, "original-hash");
    sameHashDifferentBytes.commandBytes[0] = 77;
    await expect(storage.putPending(SCOPE, sameHashDifferentBytes)).rejects.toThrow();
    const sameHashDifferentIntent = pending("transaction", 10, "original-hash");
    sameHashDifferentIntent.intentBytes[0] = 76;
    await expect(storage.putPending(SCOPE, sameHashDifferentIntent)).rejects.toThrow();

    await storage.clearReplica(SCOPE);
    expect((await storage.listPending(SCOPE)).map((value) => value.requestHash)).toEqual([
      original.requestHash,
    ]);

    await storage.deletePending(SCOPE, "transaction");
    await storage.deletePending(SCOPE, "already-absent");
    expect(await storage.listPending(SCOPE)).toEqual([]);
  });

  test("isolates identical artifact ids by stable storage namespace", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const otherScope = {
      namespace: "account-2/workspace-2/principal-2",
      artifactId: ARTIFACT_ID,
      modality: "spreadsheet" as const,
    };
    const other = replica();
    other.snapshot.stateHash = testStateHash("other-state");
    other.snapshot.digest = testStateHash("other-digest");
    other.snapshot.bytes = new Uint8Array([8]);
    other.snapshot.sequence = 8;
    other.snapshot.causalFrontier = [{ replicaId: "0000000000000002", counter: 8 }];
    other.tail = [];
    other.cursor = 8;
    other.stateHash = testStateHash("other-state");

    await storage.saveReplica(SCOPE, replica(), null);
    await storage.saveReplica(otherScope, other, null);
    await storage.putPending(SCOPE, pending("local", 1));

    expect((await storage.loadReplica(SCOPE))?.stateHash).toBe(state(5));
    expect((await storage.loadReplica(otherScope))?.stateHash).toBe(testStateHash("other-state"));
    expect(await storage.listPending(otherScope)).toEqual([]);
  });
});

describe("IndexedDbEditableArtifactStorage", () => {
  test("rejects hostile structured-clone fields with a bounded typed validation error", async () => {
    const factory = new IDBFactory();
    const databaseName = "editable-artifact-hostile-pending";
    const storage = new IndexedDbEditableArtifactStorage({ indexedDB: factory, databaseName });
    await storage.listPending(SCOPE);
    const database = await openTestDatabase(factory, databaseName);
    const transaction = database.transaction("pendingTransactions", "readwrite");
    const seeded = pending("hostile-pending", 1);
    transaction.objectStore("pendingTransactions").add({
      ...seeded,
      requestHash: 7,
      namespace: SCOPE.namespace,
      transactionId: seeded.clientTransactionId,
    });
    await transactionCompleted(transaction);
    database.close();

    await expect(storage.listPending(SCOPE)).rejects.toThrow(
      "requestHash must be a canonical sha256 digest",
    );
    await storage.close();
  });

  test("atomically replaces and clears a real IndexedDB journal with cursor deletes", async () => {
    const factory = new IDBFactory();
    const databaseName = "editable-artifact-cursor-delete";
    const storage = new IndexedDbEditableArtifactStorage({ indexedDB: factory, databaseName });
    await storage.saveReplica(SCOPE, replica(), null);
    await storage.putPending(SCOPE, pending("preserved-pending", 1));

    const replacement = replica();
    replacement.snapshot = {
      ...replacement.snapshot,
      sequence: 5,
      stateHash: state(5),
      causalFrontier: [{ replicaId: REPLICA_ID, counter: 5 }],
      digest: testStateHash("digest-5"),
      bytes: new Uint8Array([5]),
    };
    replacement.tail = [];
    await storage.saveReplica(SCOPE, replacement, {
      cursor: 5,
      stateHash: state(5),
    });
    expect(await storage.loadReplica(SCOPE)).toMatchObject({ cursor: 5, tail: [] });

    await storage.appendCommitted(SCOPE, {
      artifactId: ARTIFACT_ID,
      expectedCursor: 5,
      expectedStateHash: state(5),
      transaction: committed(6, 6, state(6), 6),
      updatedAt: 101,
    });
    await storage.clearReplica(SCOPE);

    expect(await storage.loadReplica(SCOPE)).toBeNull();
    expect((await storage.listPending(SCOPE)).map((value) => value.clientTransactionId)).toEqual([
      "preserved-pending",
    ]);
    await storage.close();
  });

  test("captures caller-owned request inputs before awaiting IndexedDB", async () => {
    const factory = new IDBFactory();
    const storage = new IndexedDbEditableArtifactStorage({
      indexedDB: factory,
      databaseName: "editable-artifact-captured-inputs",
    });
    const mutableScope = { ...SCOPE };
    const source = replica();
    const saving = storage.saveReplica(mutableScope, source, null);
    mutableScope.namespace = "mutated-namespace";
    source.snapshot.bytes[0] = 99;
    source.tail[0]!.committedTransactionBytes[0] = 99;
    source.cursor = 99;
    await saving;

    expect(await storage.loadReplica(SCOPE)).toMatchObject({ cursor: 5, stateHash: state(5) });
    expect((await storage.loadReplica(SCOPE))?.snapshot.bytes).toEqual(new Uint8Array([1, 2]));

    const appendScope = { ...SCOPE };
    const next = committed(6, 6, state(6), 6);
    const expectedCommittedBytes = next.committedTransactionBytes.slice();
    const appendInput = {
      artifactId: ARTIFACT_ID,
      expectedCursor: 5,
      expectedStateHash: state(5),
      transaction: next,
      updatedAt: 101,
    };
    const appending = storage.appendCommitted(appendScope, appendInput);
    appendScope.namespace = "mutated-namespace";
    appendInput.expectedCursor = 0;
    next.committedTransactionBytes[0] = 88;
    await appending;
    expect((await storage.loadReplica(SCOPE))?.tail.at(-1)?.committedTransactionBytes).toEqual(
      expectedCommittedBytes,
    );

    const pendingScope = { ...SCOPE };
    const local = pending("captured-pending", 7);
    const expectedCommandBytes = local.commandBytes.slice();
    const expectedIntentBytes = local.intentBytes.slice();
    const putting = storage.putPending(pendingScope, local);
    pendingScope.namespace = "mutated-namespace";
    local.commandBytes[0] = 77;
    local.intentBytes[0] = 77;
    await putting;
    expect((await storage.listPending(SCOPE))[0]).toMatchObject({
      clientTransactionId: "captured-pending",
      commandBytes: expectedCommandBytes,
      intentBytes: expectedIntentBytes,
    });
    await storage.close();
  });

  test("serializes cross-instance CAS and idempotent append transactions", async () => {
    const factory = new IDBFactory();
    const databaseName = "editable-artifact-cross-instance-cas";
    const first = new IndexedDbEditableArtifactStorage({ indexedDB: factory, databaseName });
    const second = new IndexedDbEditableArtifactStorage({ indexedDB: factory, databaseName });
    await first.saveReplica(SCOPE, replica(), null);
    const accepted = committed(6, 6, state(6), 6);
    const competing = testCommitted({
      artifactId: ARTIFACT_ID,
      transactionId: testStableId("indexed-competing"),
      startSequence: 6,
      endSequence: 6,
      priorStateHash: state(5),
      stateHash: testStateHash("competing-state"),
      causalFrontier: [{ replicaId: REPLICA_ID, counter: 6 }],
    });
    const append = (
      storage: IndexedDbEditableArtifactStorage,
      transaction: EditableArtifactCommittedTransaction,
    ) =>
      storage.appendCommitted(SCOPE, {
        artifactId: ARTIFACT_ID,
        expectedCursor: 5,
        expectedStateHash: state(5),
        transaction,
        updatedAt: 102,
      });

    const results = await Promise.allSettled([append(first, accepted), append(second, competing)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ).toBeInstanceOf(EditableArtifactStorageConflictError);

    const retained = await first.loadReplica(SCOPE);
    const winner = retained!.tail.at(-1)!;
    await expect(append(second, winner)).resolves.toBeUndefined();
    expect((await first.loadReplica(SCOPE))?.tail).toHaveLength(3);
    await Promise.all([first.close(), second.close()]);
  });

  test("checks persisted journal and WAL accounting on each new write", async () => {
    const factory = new IDBFactory();
    const journalDatabaseName = "editable-artifact-journal-hard-bound";
    const journalStorage = new IndexedDbEditableArtifactStorage({
      indexedDB: factory,
      databaseName: journalDatabaseName,
    });
    await journalStorage.saveReplica(SCOPE, replica(), null);
    const journalDatabase = await openTestDatabase(factory, journalDatabaseName);
    await updateReplicaHead(journalDatabase, (head) => ({
      ...head,
      tailBytes: 256 * 1024 * 1024,
    }));
    journalDatabase.close();

    await expect(
      journalStorage.appendCommitted(SCOPE, {
        artifactId: ARTIFACT_ID,
        expectedCursor: 5,
        expectedStateHash: state(5),
        transaction: committed(6, 6, state(6), 6),
        updatedAt: 102,
      }),
    ).rejects.toThrow("committed transaction store exceeds its byte bound");
    await journalStorage.close();

    const walDatabaseName = "editable-artifact-wal-hard-bound";
    const walStorage = new IndexedDbEditableArtifactStorage({
      indexedDB: factory,
      databaseName: walDatabaseName,
    });
    await walStorage.listPending(SCOPE);
    const walDatabase = await openTestDatabase(factory, walDatabaseName);
    const seeding = walDatabase.transaction("pendingTransactions", "readwrite");
    const pendingStore = seeding.objectStore("pendingTransactions");
    for (let index = 1; index <= 1_024; index += 1) {
      const seeded = pending(`seed-${index}`, index);
      pendingStore.add({
        ...seeded,
        namespace: SCOPE.namespace,
        transactionId: seeded.clientTransactionId,
      });
    }
    await transactionCompleted(seeding);
    walDatabase.close();

    await expect(walStorage.putPending(SCOPE, pending("overflow", 1_025))).rejects.toThrow(
      "pending transaction store exceeds its count bound",
    );
    expect(await walStorage.listPending(SCOPE)).toHaveLength(1_024);
    await walStorage.close();
  });
});

function openTestDatabase(factory: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, 3);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("test database open failed"));
  });
}

function transactionCompleted(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("test database transaction aborted"));
  });
}

async function updateReplicaHead(
  database: IDBDatabase,
  update: (head: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const transaction = database.transaction("replicas", "readwrite");
  const store = transaction.objectStore("replicas");
  const request = store.get([SCOPE.namespace, SCOPE.artifactId]);
  request.onsuccess = () => store.put(update(request.result as Record<string, unknown>));
  await transactionCompleted(transaction);
}
