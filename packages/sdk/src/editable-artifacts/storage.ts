import {
  assertCanonicalSpreadsheetArtifactCommandBytes,
  decodeEditableArtifactMutationIntent,
  EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
  EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES,
  hashEditableArtifactMutationIntentBytes,
} from "@opengeni/contracts/editable-artifacts";
import { decodeCommittedTransactionSummary } from "@opengeni/contracts/editable-artifact-committed-transaction";
import { editableArtifactCodecFor } from "@opengeni/contracts/editable-artifact-codec-registry";
import { decodeEditableArtifactSerializedCommit } from "@opengeni/contracts/editable-artifact-serialized-commit";
import type {
  EditableArtifactCommittedTransaction,
  EditableArtifactCausalFrontier,
  EditableArtifactId,
  EditableArtifactModality,
  EditableArtifactPendingTransaction,
  EditableArtifactSnapshot,
  EditableArtifactStoredReplica,
} from "./types";

/** Durable browser state required to resume one artifact without inventing state. */
export type EditableArtifactStoragePort = {
  loadReplica: (
    scope: EditableArtifactStorageScope,
  ) => Promise<EditableArtifactStoredReplica | null>;
  /** Rare full snapshot/resync replacement. Replaces the retained journal atomically. */
  saveReplica: (
    scope: EditableArtifactStorageScope,
    replica: EditableArtifactStoredReplica,
    expectedHead: EditableArtifactExpectedStoredHead,
  ) => Promise<void>;
  /** Hot path: exact-CAS one verified committed transaction onto the retained journal. */
  appendCommitted: (
    scope: EditableArtifactStorageScope,
    input: EditableArtifactAppendCommittedInput,
  ) => Promise<void>;
  /** Clears the reconstructible server state but deliberately preserves local edits. */
  clearReplica: (scope: EditableArtifactStorageScope) => Promise<void>;
  listPending: (
    scope: EditableArtifactStorageScope,
  ) => Promise<EditableArtifactPendingTransaction[]>;
  putPending: (
    scope: EditableArtifactStorageScope,
    transaction: EditableArtifactPendingTransaction,
  ) => Promise<void>;
  deletePending: (
    scope: EditableArtifactStorageScope,
    clientTransactionId: string,
  ) => Promise<void>;
};

/** Stable authorization/cache partition supplied by the authenticated host. */
export type EditableArtifactStorageScope = {
  namespace: string;
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
};

export type EditableArtifactAppendCommittedInput = {
  artifactId: EditableArtifactId;
  expectedCursor: number;
  expectedStateHash: string;
  transaction: EditableArtifactCommittedTransaction;
  updatedAt: number;
};

export type EditableArtifactExpectedStoredHead = Readonly<{
  cursor: number;
  stateHash: string;
}> | null;

/** A stable id was reused for different content. Retrying cannot resolve this. */
export class EditableArtifactStorageConflictError extends Error {
  readonly code = "editable_artifact_storage_conflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "EditableArtifactStorageConflictError";
  }
}

/**
 * Deterministic in-memory implementation for tests, SSR, and non-persistent
 * hosts. All values cross the port by copy, matching IndexedDB structured-clone
 * behavior and preventing callers from mutating retained authority by alias.
 */
export class MemoryEditableArtifactStorage implements EditableArtifactStoragePort {
  readonly #replicas = new Map<string, Map<EditableArtifactId, MemoryStoredReplica>>();
  readonly #pending = new Map<
    string,
    Map<EditableArtifactId, Map<string, EditableArtifactPendingTransaction>>
  >();

  async loadReplica(
    scope: EditableArtifactStorageScope,
  ): Promise<EditableArtifactStoredReplica | null> {
    assertScope(scope);
    const replica = this.#replicas.get(scope.namespace)?.get(scope.artifactId);
    return replica === undefined ? null : cloneMemoryStoredReplica(replica);
  }

  async saveReplica(
    scope: EditableArtifactStorageScope,
    replica: EditableArtifactStoredReplica,
    expectedHead: EditableArtifactExpectedStoredHead,
  ): Promise<void> {
    assertScopeMatchesArtifact(scope, replica.artifactId);
    assertScopeModality(scope, replica.modality);
    assertStoredReplica(replica);
    const namespace = getOrCreate(this.#replicas, scope.namespace);
    const existing = namespace.get(scope.artifactId);
    assertReplacementCanApply(existing?.head, expectedHead, replica.artifactId);
    namespace.set(scope.artifactId, toMemoryStoredReplica(replica));
  }

  async appendCommitted(
    scope: EditableArtifactStorageScope,
    input: EditableArtifactAppendCommittedInput,
  ): Promise<void> {
    assertScopeMatchesArtifact(scope, input.artifactId);
    assertScopeModality(scope, input.transaction.modality);
    assertAppendInput(input);
    const replica = this.#replicas.get(scope.namespace)?.get(scope.artifactId);
    if (replica === undefined) throw missingReplicaConflict(input.artifactId);
    if (
      replica.head.cursor >= input.transaction.endSequence &&
      replica.tail.some((transaction) => committedTransactionsEqual(transaction, input.transaction))
    ) {
      return;
    }
    assertAppendCanApply(
      {
        cursor: replica.head.cursor,
        stateHash: replica.head.stateHash,
        modality: replica.head.modality,
        ...(replica.head.snapshot.modality === "spreadsheet"
          ? { protocolVersion: replica.head.snapshot.protocolVersion }
          : {}),
      },
      input,
    );
    const transactionBytes = committedStorageBytes(input.transaction);
    if (replica.tail.length >= HARD_MAX_COMMITTED_TRANSACTIONS) {
      throw new RangeError("committed transaction store exceeds its count bound");
    }
    const nextTailBytes = checkedAggregateBytes(
      replica.tailBytes,
      transactionBytes,
      HARD_MAX_COMMITTED_BYTES,
      "committed transaction store",
    );
    replica.tail.push(cloneCommittedTransaction(input.transaction));
    replica.tailBytes = nextTailBytes;
    replica.head.cursor = input.transaction.endSequence;
    replica.head.stateHash = input.transaction.stateHash;
    replica.head.updatedAt = input.updatedAt;
  }

  async clearReplica(scope: EditableArtifactStorageScope): Promise<void> {
    assertScope(scope);
    const namespace = this.#replicas.get(scope.namespace);
    namespace?.delete(scope.artifactId);
    if (namespace?.size === 0) this.#replicas.delete(scope.namespace);
  }

  async listPending(
    scope: EditableArtifactStorageScope,
  ): Promise<EditableArtifactPendingTransaction[]> {
    assertScope(scope);
    return [...(this.#pending.get(scope.namespace)?.get(scope.artifactId)?.values() ?? [])]
      .sort(comparePendingTransactions)
      .map(clonePendingTransaction);
  }

  async putPending(
    scope: EditableArtifactStorageScope,
    transaction: EditableArtifactPendingTransaction,
  ): Promise<void> {
    assertScopeMatchesArtifact(scope, transaction.artifactId);
    assertScopeModality(scope, transaction.modality);
    assertPendingTransaction(transaction);
    const namespace = getOrCreate(this.#pending, scope.namespace);
    const artifactPending = getOrCreate(namespace, scope.artifactId);
    const existing = artifactPending.get(transaction.clientTransactionId);
    assertPendingCanReplace(existing, transaction);
    if (existing === undefined) {
      if (artifactPending.size >= HARD_MAX_PENDING_TRANSACTIONS) {
        throw new RangeError("pending transaction store exceeds its count bound");
      }
      let aggregateBytes = pendingStorageBytes(transaction);
      if (aggregateBytes > HARD_MAX_PENDING_BYTES) {
        throw new RangeError("pending transaction store exceeds its byte bound");
      }
      for (const retained of artifactPending.values()) {
        aggregateBytes = checkedAggregateBytes(
          aggregateBytes,
          pendingStorageBytes(retained),
          HARD_MAX_PENDING_BYTES,
          "pending transaction store",
        );
      }
      artifactPending.set(transaction.clientTransactionId, clonePendingTransaction(transaction));
    }
  }

  async deletePending(
    scope: EditableArtifactStorageScope,
    clientTransactionId: string,
  ): Promise<void> {
    assertScope(scope);
    const namespace = this.#pending.get(scope.namespace);
    const artifactPending = namespace?.get(scope.artifactId);
    artifactPending?.delete(clientTransactionId);
    if (artifactPending?.size === 0) namespace?.delete(scope.artifactId);
    if (namespace?.size === 0) this.#pending.delete(scope.namespace);
  }
}

type StoredReplicaHead = Omit<EditableArtifactStoredReplica, "tail">;

type MemoryStoredReplica = {
  head: StoredReplicaHead;
  tail: EditableArtifactCommittedTransaction[];
  tailBytes: number;
};

type IndexedDbStoredReplicaHead = Omit<StoredReplicaHead, "snapshot"> & {
  namespace: string;
  /** Absent only on legacy spreadsheet records. */
  modality?: EditableArtifactModality;
  /** Spreadsheet-only; absent for serialized modalities. */
  protocolVersion?: number;
  tailCount: number;
  tailBytes: number;
};
type IndexedDbStoredSnapshot = EditableArtifactSnapshot & { namespace: string };
type IndexedDbCommittedTransaction = EditableArtifactCommittedTransaction & {
  namespace: string;
};
type IndexedDbPendingTransaction = EditableArtifactPendingTransaction & {
  namespace: string;
  /** V3 IndexedDB key-path alias; always exactly clientTransactionId. */
  transactionId: string;
};
const DATABASE_VERSION = 3;
const REPLICA_HEAD_STORE = "replicas";
const SNAPSHOT_STORE = "snapshots";
const COMMITTED_STORE = "committedTransactions";
const COMMITTED_BY_SCOPE_INDEX = "byScope";
const PENDING_STORE = "pendingTransactions";
const PENDING_BY_SCOPE_INDEX = "byScope";
const HARD_MAX_SNAPSHOT_BYTES = EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES;
const HARD_MAX_COMMITTED_TRANSACTIONS = 65_536;
const HARD_MAX_COMMITTED_BYTES = 256 * 1024 * 1024;
const HARD_MAX_COMMITTED_TRANSACTION_BYTES = 8 * 1024 * 1024;
const HARD_MAX_PENDING_TRANSACTIONS = 1_024;
const HARD_MAX_PENDING_BYTES = 128 * 1024 * 1024;
const HARD_MAX_COMMAND_BYTES = EDITABLE_ARTIFACT_COMMAND_MAX_BYTES;
const HARD_MAX_INTENT_BYTES = EDITABLE_ARTIFACT_INTENT_MAX_BYTES;

export type IndexedDbEditableArtifactStorageOptions = {
  databaseName?: string;
  indexedDB?: IDBFactory;
};

/**
 * IndexedDB-backed browser storage. Writes that depend on an existing value do
 * their comparison and mutation in the same IDB transaction, so tabs cannot
 * silently replace a newer cursor or reuse an idempotency key for other bytes.
 */
export class IndexedDbEditableArtifactStorage implements EditableArtifactStoragePort {
  readonly #databaseName: string;
  readonly #factory: IDBFactory;
  #databasePromise: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDbEditableArtifactStorageOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (factory === undefined) {
      throw new Error("IndexedDB is unavailable; provide an indexedDB implementation");
    }
    this.#factory = factory;
    this.#databaseName = options.databaseName ?? "opengeni-editable-artifacts";
  }

  async loadReplica(
    scope: EditableArtifactStorageScope,
  ): Promise<EditableArtifactStoredReplica | null> {
    const ownedScope = cloneStorageScope(scope);
    const database = await this.#database();
    const transaction = database.transaction(
      [REPLICA_HEAD_STORE, SNAPSHOT_STORE, COMMITTED_STORE],
      "readonly",
    );
    const completed = transactionResult(transaction);
    const headRequest = requestResult<IndexedDbStoredReplicaHead | undefined>(
      transaction.objectStore(REPLICA_HEAD_STORE).get(scopeKey(ownedScope)),
    );
    const snapshotRequest = requestResult<IndexedDbStoredSnapshot | undefined>(
      transaction.objectStore(SNAPSHOT_STORE).get(scopeKey(ownedScope)),
    );
    const tailRequest = readBoundedIndexValues<IndexedDbCommittedTransaction>(
      transaction,
      transaction.objectStore(COMMITTED_STORE).index(COMMITTED_BY_SCOPE_INDEX),
      scopeKey(ownedScope),
      HARD_MAX_COMMITTED_TRANSACTIONS,
      HARD_MAX_COMMITTED_BYTES,
      (value) => {
        if (!(value.committedTransactionBytes instanceof Uint8Array)) {
          throw new TypeError("retained committedTransactionBytes must be a Uint8Array");
        }
        return committedStorageBytes(value);
      },
    );
    let head: IndexedDbStoredReplicaHead | undefined;
    let snapshot: IndexedDbStoredSnapshot | undefined;
    let tail: IndexedDbCommittedTransaction[];
    try {
      [head, snapshot, tail] = await Promise.all([headRequest, snapshotRequest, tailRequest]);
      await completed;
    } catch (error) {
      await completed.catch(() => undefined);
      throw error;
    }
    if (head === undefined) {
      if (snapshot !== undefined || tail.length !== 0) {
        throw new TypeError(`artifact ${ownedScope.artifactId} has retained state without a head`);
      }
      return null;
    }
    if (snapshot === undefined) {
      throw new TypeError(`artifact ${ownedScope.artifactId} has no retained snapshot`);
    }
    if (head.namespace !== ownedScope.namespace) {
      throw new TypeError("retained replica namespace does not match its storage key");
    }
    if (snapshot.namespace !== ownedScope.namespace) {
      throw new TypeError("retained snapshot namespace does not match its storage key");
    }
    let retainedTailBytes = 0;
    for (const committed of tail) {
      if (committed.namespace !== ownedScope.namespace) {
        throw new TypeError("retained journal namespace does not match its storage key");
      }
      retainedTailBytes = checkedAggregateBytes(
        retainedTailBytes,
        committedStorageBytes(committed),
        HARD_MAX_COMMITTED_BYTES,
        "retained committed transaction store",
      );
    }
    assertStoredHeadAccounting(head, tail.length, retainedTailBytes);
    const {
      namespace: _headNamespace,
      protocolVersion: retainedProtocolVersion,
      tailCount: _tailCount,
      tailBytes: _tailBytes,
      ...storedHead
    } = head;
    const { namespace: _snapshotNamespace, ...rawStoredSnapshot } = snapshot;
    const storedSnapshot = normalizeStoredSnapshot(rawStoredSnapshot, ownedScope.modality);
    const normalizedTail = tail
      .map(({ namespace: _transactionNamespace, ...value }) =>
        normalizeStoredCommitted(value, ownedScope.modality),
      )
      .sort(compareCommittedTransactions);
    const headModality = head.modality ?? "spreadsheet";
    if (headModality !== ownedScope.modality) {
      throw new TypeError("retained head modality does not match its storage scope");
    }
    if (
      storedSnapshot.modality === "spreadsheet" &&
      retainedProtocolVersion !== storedSnapshot.protocolVersion
    )
      throw new TypeError("retained head protocol does not match its snapshot");
    const replica: EditableArtifactStoredReplica = {
      ...storedHead,
      modality: ownedScope.modality,
      snapshot: storedSnapshot,
      tail: normalizedTail,
    };
    assertStoredReplica(replica);
    // IndexedDB already returned a structured clone owned by this call. The
    // namespace-stripped objects are not retained by the adapter, so another
    // full copy (including every snapshot/journal byte) adds no isolation.
    return replica;
  }

  async saveReplica(
    scope: EditableArtifactStorageScope,
    replica: EditableArtifactStoredReplica,
    expectedHead: EditableArtifactExpectedStoredHead,
  ): Promise<void> {
    const ownedScope = cloneStorageScope(scope);
    const ownedReplica = cloneStoredReplica(replica);
    const ownedExpectedHead = cloneExpectedStoredHead(expectedHead);
    assertScopeMatchesArtifact(ownedScope, ownedReplica.artifactId);
    assertScopeModality(ownedScope, ownedReplica.modality);
    assertStoredReplica(ownedReplica);
    const database = await this.#database();
    await replaceIndexedDbReplica(database, ownedScope, ownedReplica, ownedExpectedHead);
  }

  async appendCommitted(
    scope: EditableArtifactStorageScope,
    input: EditableArtifactAppendCommittedInput,
  ): Promise<void> {
    const ownedScope = cloneStorageScope(scope);
    const ownedInput: EditableArtifactAppendCommittedInput = {
      ...input,
      transaction: cloneCommittedTransaction(input.transaction),
    };
    assertScopeMatchesArtifact(ownedScope, ownedInput.artifactId);
    assertScopeModality(ownedScope, ownedInput.transaction.modality);
    assertAppendInput(ownedInput);
    const database = await this.#database();
    await appendIndexedDbCommitted(database, ownedScope, ownedInput);
  }

  async clearReplica(scope: EditableArtifactStorageScope): Promise<void> {
    const ownedScope = cloneStorageScope(scope);
    const database = await this.#database();
    await clearIndexedDbReplica(database, ownedScope);
  }

  async listPending(
    scope: EditableArtifactStorageScope,
  ): Promise<EditableArtifactPendingTransaction[]> {
    const ownedScope = cloneStorageScope(scope);
    const database = await this.#database();
    const transaction = database.transaction(PENDING_STORE, "readonly");
    const completed = transactionResult(transaction);
    let values: IndexedDbPendingTransaction[];
    try {
      values = await readBoundedIndexValues<IndexedDbPendingTransaction>(
        transaction,
        transaction.objectStore(PENDING_STORE).index(PENDING_BY_SCOPE_INDEX),
        scopeKey(ownedScope),
        HARD_MAX_PENDING_TRANSACTIONS,
        HARD_MAX_PENDING_BYTES,
        (value) => {
          if (
            !(value.commandBytes instanceof Uint8Array) ||
            !(value.intentBytes instanceof Uint8Array)
          ) {
            throw new TypeError("retained pending bytes must be Uint8Arrays");
          }
          return pendingStorageBytes(value);
        },
      );
      await completed;
    } catch (error) {
      await completed.catch(() => undefined);
      throw error;
    }
    return values
      .map(({ namespace, transactionId, ...value }) => {
        if (namespace !== ownedScope.namespace) {
          throw new TypeError("retained pending namespace does not match its storage key");
        }
        if (transactionId !== value.clientTransactionId) {
          throw new TypeError("retained pending key does not match clientTransactionId");
        }
        const normalized = normalizeStoredPending(value, ownedScope.modality);
        assertPendingTransaction(normalized);
        return normalized;
      })
      .sort(comparePendingTransactions);
  }

  async putPending(
    scope: EditableArtifactStorageScope,
    transaction: EditableArtifactPendingTransaction,
  ): Promise<void> {
    const ownedScope = cloneStorageScope(scope);
    const ownedTransaction = clonePendingTransaction(transaction);
    assertScopeMatchesArtifact(ownedScope, ownedTransaction.artifactId);
    assertScopeModality(ownedScope, ownedTransaction.modality);
    assertPendingTransaction(ownedTransaction);
    const stored: IndexedDbPendingTransaction = {
      ...ownedTransaction,
      namespace: ownedScope.namespace,
      transactionId: ownedTransaction.clientTransactionId,
    };
    const database = await this.#database();
    await putIndexedDbPending(database, ownedScope, stored);
  }

  async deletePending(
    scope: EditableArtifactStorageScope,
    clientTransactionId: string,
  ): Promise<void> {
    const ownedScope = cloneStorageScope(scope);
    const database = await this.#database();
    const transaction = database.transaction(PENDING_STORE, "readwrite");
    transaction
      .objectStore(PENDING_STORE)
      .delete([ownedScope.namespace, ownedScope.artifactId, clientTransactionId]);
    await transactionResult(transaction);
  }

  async close(): Promise<void> {
    const databasePromise = this.#databasePromise;
    this.#databasePromise = null;
    if (databasePromise !== null) (await databasePromise).close();
  }

  #database(): Promise<IDBDatabase> {
    if (this.#databasePromise === null) {
      const opening = openDatabase(this.#factory, this.#databaseName);
      this.#databasePromise = opening;
      void opening.then(
        (database) => {
          database.onclose = () => {
            if (this.#databasePromise === opening) this.#databasePromise = null;
          };
          database.onversionchange = () => {
            database.close();
            if (this.#databasePromise === opening) this.#databasePromise = null;
          };
        },
        () => {
          if (this.#databasePromise === opening) this.#databasePromise = null;
        },
      );
    }
    return this.#databasePromise;
  }
}

function cloneSnapshot(snapshot: EditableArtifactSnapshot): EditableArtifactSnapshot {
  return snapshot.modality === "spreadsheet"
    ? {
        ...snapshot,
        causalFrontier: cloneFrontier(snapshot.causalFrontier),
        bytes: snapshot.bytes.slice(),
      }
    : { ...snapshot, bytes: snapshot.bytes.slice() };
}

function cloneCommittedTransaction(
  transaction: EditableArtifactCommittedTransaction,
): EditableArtifactCommittedTransaction {
  return transaction.modality === "spreadsheet"
    ? {
        ...transaction,
        causalFrontier: cloneFrontier(transaction.causalFrontier),
        committedTransactionBytes: transaction.committedTransactionBytes.slice(),
      }
    : {
        ...transaction,
        committedTransactionBytes: transaction.committedTransactionBytes.slice(),
      };
}

function clonePendingTransaction(
  transaction: EditableArtifactPendingTransaction,
): EditableArtifactPendingTransaction {
  return transaction.modality === "spreadsheet"
    ? {
        ...transaction,
        causalBase: cloneFrontier(transaction.causalBase),
        selectiveUndoTargets: [...transaction.selectiveUndoTargets],
        commandBytes: transaction.commandBytes.slice(),
        intentBytes: transaction.intentBytes.slice(),
      }
    : {
        ...transaction,
        commandBytes: transaction.commandBytes.slice(),
        intentBytes: transaction.intentBytes.slice(),
      };
}

function cloneStoredReplica(replica: EditableArtifactStoredReplica): EditableArtifactStoredReplica {
  return {
    ...replica,
    snapshot: cloneSnapshot(replica.snapshot),
    tail: replica.tail.map(cloneCommittedTransaction),
  };
}

function cloneStorageScope(scope: EditableArtifactStorageScope): EditableArtifactStorageScope {
  const owned = {
    namespace: scope.namespace,
    artifactId: scope.artifactId,
    modality: scope.modality,
  };
  assertScope(owned);
  return owned;
}

function cloneExpectedStoredHead(
  head: EditableArtifactExpectedStoredHead,
): EditableArtifactExpectedStoredHead {
  if (head === null) return null;
  const owned = { cursor: head.cursor, stateHash: head.stateHash };
  assertSequence(owned.cursor, "expected retained cursor");
  assertNonEmpty(owned.stateHash, "expected retained stateHash");
  return owned;
}

function cloneStoredReplicaHead(replica: StoredReplicaHead): StoredReplicaHead {
  return { ...replica, snapshot: cloneSnapshot(replica.snapshot) };
}

function toStoredReplicaHead(replica: EditableArtifactStoredReplica): StoredReplicaHead {
  const { tail: _tail, ...head } = replica;
  return cloneStoredReplicaHead(head);
}

function toMemoryStoredReplica(replica: EditableArtifactStoredReplica): MemoryStoredReplica {
  return {
    head: toStoredReplicaHead(replica),
    tail: replica.tail.map(cloneCommittedTransaction),
    tailBytes: committedTailBytes(replica.tail),
  };
}

function cloneMemoryStoredReplica(replica: MemoryStoredReplica): EditableArtifactStoredReplica {
  return {
    ...cloneStoredReplicaHead(replica.head),
    tail: replica.tail.map(cloneCommittedTransaction),
  };
}

function assertStoredReplica(replica: EditableArtifactStoredReplica): void {
  assertStableId(replica.artifactId, "artifactId");
  assertModality(replica.modality, "modality");
  if (replica.snapshot.modality !== replica.modality) {
    throw new TypeError("stored snapshot modality does not match its replica");
  }
  if (replica.snapshot.artifactId !== replica.artifactId) {
    throw new TypeError("stored snapshot artifactId does not match its replica");
  }
  assertSequence(replica.snapshot.sequence, "snapshot.sequence");
  assertSequence(replica.cursor, "cursor");
  assertTimestamp(replica.updatedAt, "updatedAt");
  assertBytes(replica.snapshot.bytes, "snapshot.bytes");
  if (replica.snapshot.bytes.byteLength > HARD_MAX_SNAPSHOT_BYTES) {
    throw new RangeError("stored snapshot exceeds its hard byte bound");
  }
  assertSha256(replica.snapshot.stateHash, "snapshot.stateHash");
  assertSha256(replica.snapshot.digest, "snapshot.digest");
  if (replica.snapshot.modality === "spreadsheet") {
    assertFrontier(replica.snapshot.causalFrontier, "snapshot.causalFrontier");
    assertPositiveInteger(replica.snapshot.protocolVersion, "snapshot.protocolVersion");
  } else {
    assertSequence(replica.snapshot.nativeRevision, "snapshot.nativeRevision");
  }
  assertNonEmpty(replica.snapshot.kernelVersion, "snapshot.kernelVersion");
  assertPositiveInteger(replica.snapshot.modelSchemaVersion, "snapshot.modelSchemaVersion");
  assertSha256(replica.stateHash, "stateHash");

  let cursor = replica.snapshot.sequence;
  let stateHash = replica.snapshot.stateHash;
  let nativeRevision =
    replica.snapshot.modality === "spreadsheet" ? null : replica.snapshot.nativeRevision;
  if (replica.tail.length > HARD_MAX_COMMITTED_TRANSACTIONS) {
    throw new RangeError("stored committed tail exceeds its count bound");
  }
  let tailBytes = 0;
  for (const transaction of replica.tail) {
    assertCommittedTransaction(transaction, replica.artifactId);
    if (transaction.modality !== replica.modality) {
      throw new TypeError("stored committed tail modality does not match its replica");
    }
    tailBytes = checkedAggregateBytes(
      tailBytes,
      committedStorageBytes(transaction),
      HARD_MAX_COMMITTED_BYTES,
      "stored committed tail",
    );
    if (transaction.startSequence !== cursor + 1) {
      throw new TypeError("stored committed tail must be contiguous after its snapshot");
    }
    if (
      transaction.modality === "spreadsheet" &&
      replica.snapshot.modality === "spreadsheet" &&
      transaction.protocolVersion !== replica.snapshot.protocolVersion
    )
      throw new TypeError("stored committed tail protocol does not match its snapshot");
    if (transaction.modality !== "spreadsheet") {
      if (nativeRevision !== transaction.priorNativeRevision) {
        throw new TypeError("stored serialized tail prior native revision does not match");
      }
      nativeRevision = transaction.nativeRevision;
    }
    if (transaction.priorStateHash !== stateHash) {
      throw new TypeError("stored committed tail priorStateHash does not match prior state");
    }
    cursor = transaction.endSequence;
    stateHash = transaction.stateHash;
  }
  if (cursor !== replica.cursor) {
    throw new TypeError("stored cursor is not reconstructible from snapshot plus committed tail");
  }
  if (stateHash !== replica.stateHash) {
    throw new TypeError("stored stateHash does not match snapshot plus committed tail");
  }
}

function committedStorageBytes(
  transaction: Pick<EditableArtifactCommittedTransaction, "committedTransactionBytes">,
): number {
  if (!(transaction.committedTransactionBytes instanceof Uint8Array)) {
    throw new TypeError("committedTransactionBytes must be a Uint8Array");
  }
  return transaction.committedTransactionBytes.byteLength + 512;
}

function committedTailBytes(transactions: readonly EditableArtifactCommittedTransaction[]): number {
  let bytes = 0;
  for (const transaction of transactions) {
    bytes = checkedAggregateBytes(
      bytes,
      committedStorageBytes(transaction),
      HARD_MAX_COMMITTED_BYTES,
      "stored committed tail",
    );
  }
  return bytes;
}

function pendingStorageBytes(
  transaction: Pick<EditableArtifactPendingTransaction, "commandBytes" | "intentBytes">,
): number {
  if (
    !(transaction.commandBytes instanceof Uint8Array) ||
    !(transaction.intentBytes instanceof Uint8Array)
  ) {
    throw new TypeError("pending transaction bytes must be Uint8Arrays");
  }
  const bytes = transaction.commandBytes.byteLength + transaction.intentBytes.byteLength;
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError("pending transaction byte size is not a safe integer");
  }
  return bytes;
}

function checkedAggregateBytes(
  retainedBytes: number,
  addedBytes: number,
  maximumBytes: number,
  label: string,
): number {
  if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0) {
    throw new TypeError(`${label} has invalid retained byte accounting`);
  }
  if (!Number.isSafeInteger(addedBytes) || addedBytes < 0) {
    throw new TypeError(`${label} has an invalid added byte size`);
  }
  const aggregateBytes = retainedBytes + addedBytes;
  if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > maximumBytes) {
    throw new RangeError(`${label} exceeds its byte bound`);
  }
  return aggregateBytes;
}

function assertStoredHeadAccounting(
  head: IndexedDbStoredReplicaHead,
  tailCount: number,
  tailBytes: number,
): void {
  assertSequence(head.tailCount, "retained head tailCount");
  assertSequence(head.tailBytes, "retained head tailBytes");
  if (head.tailCount !== tailCount || head.tailBytes !== tailBytes) {
    throw new TypeError("retained head journal accounting does not match its transactions");
  }
}

function assertAppendInput(input: EditableArtifactAppendCommittedInput): void {
  assertNonEmpty(input.artifactId, "artifactId");
  assertSequence(input.expectedCursor, "expectedCursor");
  assertNonEmpty(input.expectedStateHash, "expectedStateHash");
  assertTimestamp(input.updatedAt, "updatedAt");
  assertCommittedTransaction(input.transaction, input.artifactId);
  if (input.transaction.startSequence !== input.expectedCursor + 1) {
    throw new TypeError("committed append must begin immediately after expectedCursor");
  }
  if (input.transaction.priorStateHash !== input.expectedStateHash) {
    throw new TypeError("committed append priorStateHash must equal expectedStateHash");
  }
}

function assertCommittedTransaction(
  transaction: EditableArtifactCommittedTransaction,
  artifactId: EditableArtifactId,
): void {
  if (transaction.artifactId !== artifactId) {
    throw new TypeError("committed transaction artifactId does not match its replica");
  }
  assertStableId(transaction.transactionId, "transactionId");
  assertSha256(transaction.requestHash, "requestHash");
  assertSequence(transaction.startSequence, "startSequence");
  assertSequence(transaction.endSequence, "endSequence");
  if (transaction.endSequence < transaction.startSequence) {
    throw new TypeError("committed transaction has an inverted sequence interval");
  }
  assertSha256(transaction.priorStateHash, "priorStateHash");
  assertSha256(transaction.stateHash, "stateHash");
  assertModality(transaction.modality, "transaction.modality");
  assertBytes(transaction.committedTransactionBytes, "committedTransactionBytes");
  if (transaction.committedTransactionBytes.byteLength > HARD_MAX_COMMITTED_TRANSACTION_BYTES) {
    throw new RangeError("committedTransactionBytes exceeds its hard byte bound");
  }
  if (transaction.modality === "spreadsheet") {
    assertFrontier(transaction.causalFrontier, "causalFrontier");
    assertPositiveInteger(transaction.protocolVersion, "protocolVersion");
    const summary = decodeCommittedTransactionSummary(transaction.committedTransactionBytes);
    if (
      summary.transactionId !== transaction.transactionId ||
      summary.operationProtocolVersion !== transaction.protocolVersion ||
      summary.priorStateHash !== transaction.priorStateHash ||
      summary.stateHash !== transaction.stateHash ||
      !frontiersEqual(summary.resultingCausalFrontier, transaction.causalFrontier)
    )
      throw new TypeError("committed fields do not exactly match their OGACO envelope");
    return;
  }
  assertSequence(transaction.priorNativeRevision, "priorNativeRevision");
  assertSequence(transaction.nativeRevision, "nativeRevision");
  assertPositiveInteger(transaction.commitProtocolVersion, "commitProtocolVersion");
  const summary = decodeEditableArtifactSerializedCommit(
    transaction.committedTransactionBytes,
    transaction.modality,
  );
  if (
    summary.transactionId !== transaction.transactionId ||
    summary.requestHash !== transaction.requestHash ||
    summary.parentHeadSequence + 1 !== transaction.startSequence ||
    summary.resultHeadSequence !== transaction.endSequence ||
    summary.priorNativeRevision !== transaction.priorNativeRevision ||
    summary.nativeReceipt.revision !== transaction.nativeRevision ||
    summary.commitProtocolVersion !== transaction.commitProtocolVersion ||
    summary.priorStateHash !== transaction.priorStateHash ||
    summary.stateHash !== transaction.stateHash
  )
    throw new TypeError("committed fields do not exactly match their OGAST envelope");
}

function assertPendingTransaction(transaction: EditableArtifactPendingTransaction): void {
  assertStableId(transaction.artifactId, "artifactId");
  assertClientTransactionId(transaction.clientTransactionId, "clientTransactionId");
  assertSha256(transaction.requestHash, "requestHash");
  assertPositiveU16(transaction.protocolVersion, "protocolVersion");
  assertPositiveU16(transaction.modelSchemaVersion, "modelSchemaVersion");
  assertPositiveU16(transaction.commandVersion, "commandVersion");
  assertReplicaId(transaction.replicaId, "replicaId");
  assertPositiveInteger(transaction.replicaCounter, "replicaCounter");
  if (transaction.previousLocalTransactionId !== null) {
    assertClientTransactionId(transaction.previousLocalTransactionId, "previousLocalTransactionId");
    if (transaction.previousLocalTransactionId === transaction.clientTransactionId) {
      throw new TypeError("pending transaction cannot depend on itself");
    }
  }
  assertModality(transaction.modality, "pending.modality");
  assertTimestamp(transaction.createdAt, "createdAt");
  assertSequence(transaction.observedHeadSequence, "observedHeadSequence");
  assertBytes(transaction.commandBytes, "commandBytes");
  assertBytes(transaction.intentBytes, "intentBytes");
  if (transaction.commandBytes.byteLength > HARD_MAX_COMMAND_BYTES) {
    throw new RangeError("commandBytes exceeds its hard byte bound");
  }
  if (transaction.intentBytes.byteLength > HARD_MAX_INTENT_BYTES) {
    throw new RangeError("intentBytes exceeds its hard byte bound");
  }
  if (transaction.modality === "spreadsheet") {
    assertFrontier(transaction.causalBase, "causalBase");
    assertIdentifiers(transaction.selectiveUndoTargets, "selectiveUndoTargets");
    assertCanonicalSpreadsheetArtifactCommandBytes(transaction.commandBytes);
  } else {
    assertSequence(transaction.observedNativeRevision, "observedNativeRevision");
    editableArtifactCodecFor({
      durableModality: transaction.modality,
      modelSchemaVersion: transaction.modelSchemaVersion,
      commandProtocolVersion: transaction.commandVersion,
    }).command.assertCanonical(transaction.commandBytes);
  }
  const intent = decodeEditableArtifactMutationIntent(transaction.intentBytes);
  if (
    intent.artifactId !== transaction.artifactId ||
    intent.clientTransactionId !== transaction.clientTransactionId ||
    intent.replicaId !== transaction.replicaId ||
    intent.replicaCounter !== transaction.replicaCounter ||
    intent.previousLocalTransactionId !== transaction.previousLocalTransactionId ||
    intent.protocolVersion !== transaction.protocolVersion ||
    intent.modelSchemaVersion !== transaction.modelSchemaVersion ||
    intent.commandProtocolVersion !== transaction.commandVersion ||
    intent.observedHeadSequence !== transaction.observedHeadSequence ||
    !bytesEqual(intent.commandBytes, transaction.commandBytes)
  ) {
    throw new TypeError("pending fields do not exactly match their OGATX envelope");
  }
  if (
    transaction.modality === "spreadsheet"
      ? !frontiersEqual(intent.causalBase, transaction.causalBase) ||
        !identifiersEqual(intent.selectiveUndoOperationIds, transaction.selectiveUndoTargets)
      : intent.causalBase.length !== 0 || intent.selectiveUndoOperationIds.length !== 0
  )
    throw new TypeError("pending causality does not match its durable modality");
  if (
    hashEditableArtifactMutationIntentBytes(transaction.intentBytes) !== transaction.requestHash
  ) {
    throw new TypeError("pending requestHash does not match its OGATX envelope");
  }
}

function assertAppendCanApply(
  head: Pick<StoredReplicaHead, "cursor" | "stateHash"> & {
    modality?: EditableArtifactModality;
    protocolVersion?: number;
  },
  input: EditableArtifactAppendCommittedInput,
): void {
  if (head.cursor !== input.expectedCursor || head.stateHash !== input.expectedStateHash) {
    throw new EditableArtifactStorageConflictError(
      `artifact ${input.artifactId} retained head no longer matches append expectation`,
    );
  }
  const headModality = head.modality ?? "spreadsheet";
  if (input.transaction.modality !== headModality) {
    throw new EditableArtifactStorageConflictError(
      `artifact ${input.artifactId} append modality does not match retained snapshot`,
    );
  }
  if (
    input.transaction.modality === "spreadsheet" &&
    input.transaction.protocolVersion !== head.protocolVersion
  ) {
    throw new EditableArtifactStorageConflictError(
      `artifact ${input.artifactId} append protocol does not match retained snapshot`,
    );
  }
}

function assertReplacementCanApply(
  head:
    | (Pick<StoredReplicaHead, "cursor" | "stateHash"> & {
        protocolVersion?: number;
      })
    | undefined,
  expectedHead: EditableArtifactExpectedStoredHead,
  artifactId: EditableArtifactId,
): void {
  if (expectedHead === null) {
    if (head === undefined) return;
  } else if (
    head !== undefined &&
    head.cursor === expectedHead.cursor &&
    head.stateHash === expectedHead.stateHash
  ) {
    return;
  }
  throw new EditableArtifactStorageConflictError(
    `artifact ${artifactId} retained head changed before snapshot replacement`,
  );
}

function missingReplicaConflict(
  artifactId: EditableArtifactId,
): EditableArtifactStorageConflictError {
  return new EditableArtifactStorageConflictError(
    `artifact ${artifactId} has no retained replica to append to`,
  );
}

function compareCommittedTransactions(
  left: EditableArtifactCommittedTransaction,
  right: EditableArtifactCommittedTransaction,
): number {
  if (left.startSequence !== right.startSequence) {
    return left.startSequence < right.startSequence ? -1 : 1;
  }
  if (left.transactionId === right.transactionId) return 0;
  return left.transactionId < right.transactionId ? -1 : 1;
}

function assertPendingCanReplace(
  existing: EditableArtifactPendingTransaction | undefined,
  next: EditableArtifactPendingTransaction,
): void {
  if (existing !== undefined && !pendingTransactionsEqual(existing, next)) {
    throw new EditableArtifactStorageConflictError(
      `pending transaction ${next.clientTransactionId} was reused with different immutable content`,
    );
  }
}

function pendingTransactionsEqual(
  left: EditableArtifactPendingTransaction,
  right: EditableArtifactPendingTransaction,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.modality === right.modality &&
    left.clientTransactionId === right.clientTransactionId &&
    left.requestHash === right.requestHash &&
    left.protocolVersion === right.protocolVersion &&
    left.modelSchemaVersion === right.modelSchemaVersion &&
    left.commandVersion === right.commandVersion &&
    left.replicaId === right.replicaId &&
    left.replicaCounter === right.replicaCounter &&
    left.previousLocalTransactionId === right.previousLocalTransactionId &&
    left.observedHeadSequence === right.observedHeadSequence &&
    left.createdAt === right.createdAt &&
    (left.modality === "spreadsheet" && right.modality === "spreadsheet"
      ? frontiersEqual(left.causalBase, right.causalBase) &&
        identifiersEqual(left.selectiveUndoTargets, right.selectiveUndoTargets)
      : left.modality !== "spreadsheet" &&
        right.modality !== "spreadsheet" &&
        left.observedNativeRevision === right.observedNativeRevision) &&
    bytesEqual(left.commandBytes, right.commandBytes) &&
    bytesEqual(left.intentBytes, right.intentBytes)
  );
}

function committedTransactionsEqual(
  left: EditableArtifactCommittedTransaction,
  right: EditableArtifactCommittedTransaction,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.modality === right.modality &&
    left.transactionId === right.transactionId &&
    left.requestHash === right.requestHash &&
    left.startSequence === right.startSequence &&
    left.endSequence === right.endSequence &&
    left.priorStateHash === right.priorStateHash &&
    left.stateHash === right.stateHash &&
    (left.modality === "spreadsheet" && right.modality === "spreadsheet"
      ? left.protocolVersion === right.protocolVersion &&
        frontiersEqual(left.causalFrontier, right.causalFrontier)
      : left.modality !== "spreadsheet" &&
        right.modality !== "spreadsheet" &&
        left.priorNativeRevision === right.priorNativeRevision &&
        left.nativeRevision === right.nativeRevision &&
        left.commitProtocolVersion === right.commitProtocolVersion) &&
    bytesEqual(left.committedTransactionBytes, right.committedTransactionBytes)
  );
}

function frontiersEqual(
  left: EditableArtifactCausalFrontier,
  right: EditableArtifactCausalFrontier,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.replicaId === right[index]?.replicaId && entry.counter === right[index]?.counter,
    )
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function comparePendingTransactions(
  left: EditableArtifactPendingTransaction,
  right: EditableArtifactPendingTransaction,
): number {
  if (left.replicaCounter !== right.replicaCounter) {
    return left.replicaCounter < right.replicaCounter ? -1 : 1;
  }
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.clientTransactionId === right.clientTransactionId) return 0;
  return left.clientTransactionId < right.clientTransactionId ? -1 : 1;
}

function assertScope(scope: EditableArtifactStorageScope): void {
  assertNonEmpty(scope.namespace, "storage namespace");
  assertStableId(scope.artifactId, "storage artifactId");
  assertModality(scope.modality, "storage modality");
}

function assertModality(value: unknown, path: string): asserts value is EditableArtifactModality {
  if (value !== "document" && value !== "spreadsheet" && value !== "presentation") {
    throw new TypeError(`${path} must be document, spreadsheet, or presentation`);
  }
}

function assertScopeMatchesArtifact(
  scope: EditableArtifactStorageScope,
  artifactId: EditableArtifactId,
): void {
  assertScope(scope);
  if (scope.artifactId !== artifactId) {
    throw new TypeError("storage scope artifactId does not match the retained value");
  }
}

function assertScopeModality(
  scope: EditableArtifactStorageScope,
  modality: EditableArtifactModality,
): void {
  if (scope.modality !== modality) {
    throw new TypeError("storage scope modality does not match the retained value");
  }
}

function normalizeStoredSnapshot(
  snapshot: Omit<IndexedDbStoredSnapshot, "namespace">,
  modality: EditableArtifactModality,
): EditableArtifactSnapshot {
  const retainedModality =
    (snapshot as { modality?: EditableArtifactModality }).modality ?? "spreadsheet";
  if (retainedModality !== modality) {
    throw new TypeError("retained snapshot modality does not match its storage scope");
  }
  return { ...snapshot, modality } as EditableArtifactSnapshot;
}

function normalizeStoredCommitted(
  transaction: Omit<IndexedDbCommittedTransaction, "namespace">,
  modality: EditableArtifactModality,
): EditableArtifactCommittedTransaction {
  const retainedModality =
    (transaction as { modality?: EditableArtifactModality }).modality ?? "spreadsheet";
  if (retainedModality !== modality) {
    throw new TypeError("retained transaction modality does not match its storage scope");
  }
  return { ...transaction, modality } as EditableArtifactCommittedTransaction;
}

function normalizeStoredPending(
  transaction: Omit<IndexedDbPendingTransaction, "namespace" | "transactionId">,
  modality: EditableArtifactModality,
): EditableArtifactPendingTransaction {
  const retainedModality =
    (transaction as { modality?: EditableArtifactModality }).modality ?? "spreadsheet";
  if (retainedModality !== modality) {
    throw new TypeError("retained pending modality does not match its storage scope");
  }
  return { ...transaction, modality } as EditableArtifactPendingTransaction;
}

function scopeKey(scope: EditableArtifactStorageScope): [string, EditableArtifactId] {
  return [scope.namespace, scope.artifactId];
}

function getOrCreate<OuterKey, InnerKey, Value>(
  outer: Map<OuterKey, Map<InnerKey, Value>>,
  key: OuterKey,
): Map<InnerKey, Value> {
  const existing = outer.get(key);
  if (existing !== undefined) return existing;
  const created = new Map<InnerKey, Value>();
  outer.set(key, created);
  return created;
}

function assertFrontier(frontier: EditableArtifactCausalFrontier, path: string): void {
  if (!Array.isArray(frontier)) throw new TypeError(`${path} must be an array`);
  let previous: string | null = null;
  for (const [index, entry] of frontier.entries()) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.getPrototypeOf(entry) !== Object.prototype
    ) {
      throw new TypeError(`${path}[${index}] must be a plain object`);
    }
    assertReplicaId(entry.replicaId, `${path}[${index}].replicaId`);
    assertPositiveInteger(entry.counter, `${path}[${index}].counter`);
    if (previous !== null && previous >= entry.replicaId) {
      throw new TypeError(`${path} must be strictly sorted and duplicate-free`);
    }
    previous = entry.replicaId;
  }
}

function cloneFrontier(frontier: EditableArtifactCausalFrontier): EditableArtifactCausalFrontier {
  return frontier.map((entry) => ({ ...entry }));
}

function assertIdentifiers(values: readonly string[], path: string): void {
  if (!Array.isArray(values)) throw new TypeError(`${path} must be an array`);
  let previous: string | null = null;
  for (const value of values) {
    assertStableId(value, path);
    if (previous !== null && previous >= value) {
      throw new TypeError(`${path} must be strictly sorted and duplicate-free`);
    }
    previous = value;
  }
}

function identifiersEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertBytes(value: Uint8Array, path: string): void {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${path} must be a Uint8Array`);
}

function assertSequence(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
}

function assertPositiveU16(value: number, path: string): void {
  assertPositiveInteger(value, path);
  if (value > 0xffff) throw new TypeError(`${path} must fit an unsigned 16-bit integer`);
}

function assertTimestamp(value: number, path: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative finite number`);
  }
}

function assertNonEmpty(
  value: unknown,
  path: string,
  maximumCodeUnits = 4_096,
): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  if (value.length === 0) throw new TypeError(`${path} must not be empty`);
  if (value.length > maximumCodeUnits) {
    throw new RangeError(`${path} exceeds its string bound`);
  }
}

function assertStableId(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^(?!0{32}$)[a-f0-9]{32}$/u.test(value)) {
    throw new TypeError(`${path} must be 32 lowercase nonzero hex characters`);
  }
}

function assertReplicaId(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^(?!0{16}$)[a-f0-9]{16}$/u.test(value)) {
    throw new TypeError(`${path} must be 16 lowercase nonzero hex characters`);
  }
}

function assertClientTransactionId(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
    throw new TypeError(`${path} must be a canonical portable transaction id`);
  }
}

function assertSha256(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${path} must be a canonical sha256 digest`);
  }
}

function openDatabase(factory: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, DATABASE_VERSION);
    let rejectedWhileBlocked = false;
    request.onerror = () => reject(request.error ?? new Error("failed to open artifact storage"));
    request.onblocked = () => {
      rejectedWhileBlocked = true;
      reject(new Error("artifact storage upgrade is blocked"));
    };
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (event.oldVersion < 2) {
        // V1 records had no principal partition. They cannot be attributed
        // safely, so discard this rebuildable cache instead of guessing scope.
        for (const name of [REPLICA_HEAD_STORE, SNAPSHOT_STORE, PENDING_STORE, COMMITTED_STORE]) {
          if (database.objectStoreNames.contains(name)) database.deleteObjectStore(name);
        }
      } else if (event.oldVersion < 3) {
        // V2 heads did not retain constant-time journal accounting. Confirmed
        // state is reconstructible, so rebuild it while preserving the pending WAL.
        for (const name of [REPLICA_HEAD_STORE, SNAPSHOT_STORE, COMMITTED_STORE]) {
          if (database.objectStoreNames.contains(name)) database.deleteObjectStore(name);
        }
      }
      if (!database.objectStoreNames.contains(REPLICA_HEAD_STORE)) {
        database.createObjectStore(REPLICA_HEAD_STORE, {
          keyPath: ["namespace", "artifactId"],
        });
      }
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        database.createObjectStore(SNAPSHOT_STORE, {
          keyPath: ["namespace", "artifactId"],
        });
      }
      if (!database.objectStoreNames.contains(COMMITTED_STORE)) {
        const committed = database.createObjectStore(COMMITTED_STORE, {
          keyPath: ["namespace", "artifactId", "startSequence"],
        });
        committed.createIndex(COMMITTED_BY_SCOPE_INDEX, ["namespace", "artifactId"], {
          unique: false,
        });
      }
      if (!database.objectStoreNames.contains(PENDING_STORE)) {
        const pending = database.createObjectStore(PENDING_STORE, {
          keyPath: ["namespace", "artifactId", "transactionId"],
        });
        pending.createIndex(PENDING_BY_SCOPE_INDEX, ["namespace", "artifactId"], {
          unique: false,
        });
      }
    };
    request.onsuccess = () => {
      if (rejectedWhileBlocked) request.result.close();
      else resolve(request.result);
    };
  });
}

function replaceIndexedDbReplica(
  database: IDBDatabase,
  scope: EditableArtifactStorageScope,
  replica: EditableArtifactStoredReplica,
  expectedHead: EditableArtifactExpectedStoredHead,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      [REPLICA_HEAD_STORE, SNAPSHOT_STORE, COMMITTED_STORE],
      "readwrite",
    );
    const headStore = transaction.objectStore(REPLICA_HEAD_STORE);
    const snapshotStore = transaction.objectStore(SNAPSHOT_STORE);
    const committedStore = transaction.objectStore(COMMITTED_STORE);
    let semanticError: unknown;
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => rejectTransaction(reject, transaction, semanticError);

    const headRead = headStore.get(scopeKey(scope));
    headRead.onerror = () => {
      semanticError = headRead.error ?? new Error("artifact replica head lookup failed");
    };
    headRead.onsuccess = () => {
      try {
        const retained = headRead.result as IndexedDbStoredReplicaHead | undefined;
        if (
          retained !== undefined &&
          (retained.namespace !== scope.namespace || retained.artifactId !== scope.artifactId)
        ) {
          throw new TypeError("retained replica head does not match its storage key");
        }
        assertReplacementCanApply(retained, expectedHead, replica.artifactId);
      } catch (error) {
        semanticError = error;
        transaction.abort();
        return;
      }
      deleteIndexedDbScope(
        committedStore.index(COMMITTED_BY_SCOPE_INDEX),
        scopeKey(scope),
        () => {
          try {
            for (const committed of replica.tail) {
              const stored: IndexedDbCommittedTransaction = {
                ...committed,
                namespace: scope.namespace,
              };
              committedStore.add(stored);
            }
            const head: IndexedDbStoredReplicaHead = {
              namespace: scope.namespace,
              artifactId: replica.artifactId,
              cursor: replica.cursor,
              stateHash: replica.stateHash,
              updatedAt: replica.updatedAt,
              modality: replica.modality,
              ...(replica.snapshot.modality === "spreadsheet"
                ? { protocolVersion: replica.snapshot.protocolVersion }
                : {}),
              tailCount: replica.tail.length,
              tailBytes: committedTailBytes(replica.tail),
            };
            const snapshot: IndexedDbStoredSnapshot = {
              ...replica.snapshot,
              namespace: scope.namespace,
            };
            snapshotStore.put(snapshot);
            headStore.put(head);
          } catch (error) {
            semanticError = error;
            transaction.abort();
          }
        },
        (error) => {
          semanticError = error;
          transaction.abort();
        },
      );
    };
  });
}

function appendIndexedDbCommitted(
  database: IDBDatabase,
  scope: EditableArtifactStorageScope,
  input: EditableArtifactAppendCommittedInput,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([REPLICA_HEAD_STORE, COMMITTED_STORE], "readwrite");
    const headStore = transaction.objectStore(REPLICA_HEAD_STORE);
    const committedStore = transaction.objectStore(COMMITTED_STORE);
    let semanticError: unknown;
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => rejectTransaction(reject, transaction, semanticError);

    const headRead = headStore.get(scopeKey(scope));
    headRead.onerror = () => {
      semanticError = headRead.error ?? new Error("artifact replica head lookup failed");
    };
    headRead.onsuccess = () => {
      try {
        const head = headRead.result as IndexedDbStoredReplicaHead | undefined;
        if (head === undefined) throw missingReplicaConflict(scope.artifactId);
        if (head.namespace !== scope.namespace || head.artifactId !== scope.artifactId) {
          throw new TypeError("retained replica does not match its storage key");
        }
        assertSequence(head.tailCount, "retained head tailCount");
        assertSequence(head.tailBytes, "retained head tailBytes");
        if (
          head.tailCount > HARD_MAX_COMMITTED_TRANSACTIONS ||
          head.tailBytes > HARD_MAX_COMMITTED_BYTES
        ) {
          throw new RangeError("retained head journal accounting exceeds its hard bound");
        }
        if (head.cursor !== input.expectedCursor || head.stateHash !== input.expectedStateHash) {
          const retainedRead = committedStore.get([
            scope.namespace,
            scope.artifactId,
            input.transaction.startSequence,
          ]);
          retainedRead.onerror = () => {
            semanticError =
              retainedRead.error ?? new Error("artifact committed transaction lookup failed");
          };
          retainedRead.onsuccess = () => {
            try {
              const retained = retainedRead.result as IndexedDbCommittedTransaction | undefined;
              if (
                head.cursor >= input.transaction.endSequence &&
                retained !== undefined &&
                retained.namespace === scope.namespace &&
                committedTransactionsEqual(retained, input.transaction)
              ) {
                return;
              }
              assertAppendCanApply(head, input);
            } catch (error) {
              semanticError = error;
              transaction.abort();
            }
          };
          return;
        }
        assertAppendCanApply(head, input);
        if (head.tailCount >= HARD_MAX_COMMITTED_TRANSACTIONS) {
          throw new RangeError("committed transaction store exceeds its count bound");
        }
        const nextTailBytes = checkedAggregateBytes(
          head.tailBytes,
          committedStorageBytes(input.transaction),
          HARD_MAX_COMMITTED_BYTES,
          "committed transaction store",
        );
        const committed: IndexedDbCommittedTransaction = {
          ...input.transaction,
          namespace: scope.namespace,
        };
        committedStore.add(committed);
        const nextHead: IndexedDbStoredReplicaHead = {
          ...head,
          cursor: input.transaction.endSequence,
          stateHash: input.transaction.stateHash,
          updatedAt: input.updatedAt,
          tailCount: head.tailCount + 1,
          tailBytes: nextTailBytes,
        };
        headStore.put(nextHead);
      } catch (error) {
        semanticError = error;
        transaction.abort();
      }
    };
  });
}

function clearIndexedDbReplica(
  database: IDBDatabase,
  scope: EditableArtifactStorageScope,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      [REPLICA_HEAD_STORE, SNAPSHOT_STORE, COMMITTED_STORE],
      "readwrite",
    );
    const committedStore = transaction.objectStore(COMMITTED_STORE);
    let semanticError: unknown;
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => rejectTransaction(reject, transaction, semanticError);
    transaction.objectStore(REPLICA_HEAD_STORE).delete(scopeKey(scope));
    transaction.objectStore(SNAPSHOT_STORE).delete(scopeKey(scope));
    deleteIndexedDbScope(
      committedStore.index(COMMITTED_BY_SCOPE_INDEX),
      scopeKey(scope),
      () => undefined,
      (error) => {
        semanticError = error;
        transaction.abort();
      },
    );
  });
}

function deleteIndexedDbScope(
  index: IDBIndex,
  query: IDBValidKey,
  onComplete: () => void,
  onError: (error: unknown) => void,
): void {
  const cursorRequest = index.openKeyCursor(query);
  cursorRequest.onerror = () =>
    onError(cursorRequest.error ?? new Error("artifact storage delete cursor failed"));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor === null) {
      onComplete();
      return;
    }
    try {
      // Queue deletion and cursor advancement from the cursor callback while
      // the read/write transaction is definitely active. Waiting for a
      // separate delete callback before `continue()` is not portable across
      // real browser IndexedDB implementations. A key-only cursor avoids
      // deserializing the value but must delete through the object store.
      const deletion = index.objectStore.delete(cursor.primaryKey);
      deletion.onerror = () =>
        onError(deletion.error ?? new Error("artifact storage journal delete failed"));
      cursor.continue();
    } catch (error) {
      onError(error);
    }
  };
}

function rejectTransaction(
  reject: (reason?: unknown) => void,
  transaction: IDBTransaction,
  semanticError?: unknown,
): void {
  reject(
    semanticError ??
      transaction.error ??
      new Error("artifact storage transaction failed or was aborted"),
  );
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("artifact storage request failed"));
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("artifact storage transaction was aborted"));
  });
}

function readBoundedIndexValues<T>(
  transaction: IDBTransaction,
  index: IDBIndex,
  query: IDBValidKey,
  maximumCount: number,
  maximumBytes: number,
  measure: (value: T) => number,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const values: T[] = [];
    let aggregateBytes = 0;
    let settled = false;
    const request = index.openCursor(query);
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      try {
        transaction.abort();
      } catch {
        // The transaction may already be aborting because the cursor failed.
      }
      reject(error);
    };
    request.onerror = () => fail(request.error ?? new Error("artifact storage cursor failed"));
    request.onsuccess = () => {
      if (settled) return;
      const cursor = request.result;
      if (cursor === null) {
        settled = true;
        resolve(values);
        return;
      }
      try {
        const value = cursor.value as T;
        if (values.length >= maximumCount) {
          throw new RangeError("artifact storage cursor exceeds its count bound");
        }
        const measured = measure(value);
        if (!Number.isSafeInteger(measured) || measured < 0) {
          throw new TypeError("artifact storage cursor returned an invalid byte measurement");
        }
        aggregateBytes += measured;
        if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > maximumBytes) {
          throw new RangeError("artifact storage cursor exceeds its byte bound");
        }
        values.push(value);
        cursor.continue();
      } catch (error) {
        fail(error);
      }
    };
  });
}

function putIndexedDbPending(
  database: IDBDatabase,
  scope: EditableArtifactStorageScope,
  value: IndexedDbPendingTransaction,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PENDING_STORE, "readwrite", {
      durability: "strict",
    });
    const store = transaction.objectStore(PENDING_STORE);
    let semanticError: unknown;
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        semanticError ?? transaction.error ?? new Error("artifact pending transaction was aborted"),
      );

    const abort = (error: unknown): void => {
      semanticError ??= error;
      try {
        transaction.abort();
      } catch {
        // A failed request may already be aborting the transaction.
      }
    };

    const read = store.get([scope.namespace, scope.artifactId, value.transactionId]);
    read.onerror = () => {
      semanticError = read.error ?? new Error("artifact pending lookup failed");
    };
    read.onsuccess = () => {
      try {
        const existing = read.result as IndexedDbPendingTransaction | undefined;
        assertPendingCanReplace(existing, value);
        if (existing !== undefined) return;
      } catch (error) {
        abort(error);
        return;
      }

      let retainedCount = 0;
      let aggregateBytes: number;
      try {
        aggregateBytes = pendingStorageBytes(value);
        if (aggregateBytes > HARD_MAX_PENDING_BYTES) {
          throw new RangeError("pending transaction store exceeds its byte bound");
        }
      } catch (error) {
        abort(error);
        return;
      }

      const cursorRequest = store.index(PENDING_BY_SCOPE_INDEX).openCursor(scopeKey(scope));
      cursorRequest.onerror = () => {
        semanticError = cursorRequest.error ?? new Error("artifact pending bound cursor failed");
      };
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor === null) {
          store.add(value);
          return;
        }
        try {
          const retained = cursor.value as IndexedDbPendingTransaction;
          if (retained.namespace !== scope.namespace || retained.artifactId !== scope.artifactId) {
            throw new TypeError("retained pending transaction does not match its index key");
          }
          assertPendingTransaction(retained);
          retainedCount += 1;
          if (retainedCount >= HARD_MAX_PENDING_TRANSACTIONS) {
            throw new RangeError("pending transaction store exceeds its count bound");
          }
          aggregateBytes = checkedAggregateBytes(
            aggregateBytes,
            pendingStorageBytes(retained),
            HARD_MAX_PENDING_BYTES,
            "pending transaction store",
          );
          cursor.continue();
        } catch (error) {
          abort(error);
        }
      };
    };
  });
}
