import { describe, expect, test } from "bun:test";
import {
  EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
} from "@opengeni/contracts/editable-artifacts";
import {
  createEditableArtifactSyncController,
  type CreateEditableArtifactSyncControllerOptions,
  type EditableArtifactSyncController,
} from "../../src/editable-artifacts/controller";
import {
  EditableArtifactSyncError,
  EditableArtifactTransportError,
} from "../../src/editable-artifacts/errors";
import { EditableArtifactSyncPool } from "../../src/editable-artifacts/pool";
import {
  MemoryEditableArtifactStorage,
  type EditableArtifactStorageScope,
} from "../../src/editable-artifacts/storage";
import type {
  EditableArtifactBlockedPending,
  EditableArtifactBootstrap,
  EditableArtifactCommittedTransaction,
  EditableArtifactLiveClose,
  EditableArtifactLiveConnection,
  EditableArtifactLiveMessage,
  EditableArtifactPendingTransaction,
  EditableArtifactReplayPage,
  EditableArtifactSnapshot,
  EditableArtifactSpreadsheetCommittedTransaction,
  EditableArtifactSpreadsheetSnapshot,
  EditableArtifactSubmitReceipt,
  EditableArtifactSyncScheduler,
  EditableArtifactSyncTicket,
  EditableArtifactSyncTransport,
  EditableArtifactWorkerKernel,
} from "../../src/editable-artifacts/types";
import { testCommand, testCommitted, testPending } from "./protocol-fixtures";

const ARTIFACT_ID = "0123456789abcdef0123456789abcdef";
const NOW = 2_000_000_000_000;
const KERNEL_VERSION = "kernel-1";
const MODEL_SCHEMA_VERSION = 1;
const STORAGE_SCOPE = {
  namespace: JSON.stringify([
    "https://host.test",
    "account",
    "workspace",
    "principal",
    "auth-epoch-1",
  ]),
  artifactId: ARTIFACT_ID,
  modality: "spreadsheet" as const,
};

function sha(value: number): string {
  return `sha256:${Math.max(0, value).toString(16).padStart(64, "0")}`;
}

function frontier(counter: number) {
  return counter === 0 ? [] : ([{ replicaId: "1111111111111111", counter }] as const);
}

function snapshot(sequence: number, byte = sequence + 1): EditableArtifactSpreadsheetSnapshot {
  return {
    modality: "spreadsheet",
    artifactId: ARTIFACT_ID,
    sequence,
    stateHash: sha(100 + sequence),
    causalFrontier: frontier(sequence),
    digest: sha(byte),
    protocolVersion: 1,
    kernelVersion: KERNEL_VERSION,
    modelSchemaVersion: MODEL_SCHEMA_VERSION,
    bytes: new Uint8Array([byte]),
  };
}

function committed(
  sequence: number,
  options: {
    transactionId?: string;
    requestHash?: string;
    committedTransactionBytes?: Uint8Array;
  } = {},
): EditableArtifactSpreadsheetCommittedTransaction {
  const transaction = testCommitted({
    artifactId: ARTIFACT_ID,
    transactionId: options.transactionId ?? `tx-${sequence}`,
    requestHash: options.requestHash ?? sha(1_000 + sequence),
    startSequence: sequence,
    endSequence: sequence,
    priorStateHash: sha(99 + sequence),
    stateHash: sha(100 + sequence),
    causalFrontier: frontier(sequence),
    protocolVersion: 1,
  });
  return options.committedTransactionBytes === undefined
    ? transaction
    : { ...transaction, committedTransactionBytes: options.committedTransactionBytes };
}

function receipt(
  pending: EditableArtifactPendingTransaction,
  transaction: EditableArtifactCommittedTransaction,
): EditableArtifactSubmitReceipt {
  return {
    artifactId: ARTIFACT_ID,
    clientTransactionId: pending.clientTransactionId,
    transactionId: transaction.transactionId,
    requestHash: pending.requestHash,
    committed: transaction,
  };
}

function bootstrap(
  headSequence: number,
  value: {
    snapshot?: EditableArtifactSnapshot | null;
    writable?: boolean;
    resyncRequired?: boolean;
  } = {},
): Extract<EditableArtifactBootstrap, { modality: "spreadsheet" }> {
  return {
    modality: "spreadsheet",
    artifactId: ARTIFACT_ID,
    protocolVersion: 1,
    headSequence,
    headStateHash: sha(100 + headSequence),
    headCausalFrontier: frontier(headSequence),
    kernelVersion: KERNEL_VERSION,
    modelSchemaVersion: MODEL_SCHEMA_VERSION,
    writable: value.writable ?? true,
    minimumReplaySequence: 1,
    snapshot: value.snapshot === undefined ? null : value.snapshot,
    resyncRequired: value.resyncRequired ?? false,
  };
}

type ConnectionPlan = {
  bootstrap: EditableArtifactBootstrap | (() => EditableArtifactBootstrap);
  beforeBootstrap?: EditableArtifactLiveMessage[];
  limits?: Partial<EditableArtifactLiveConnection["limits"]>;
};

class DeferredConnection implements EditableArtifactLiveConnection {
  readonly limits: EditableArtifactLiveConnection["limits"];
  readonly streamEpoch: string;
  readonly closed: Promise<EditableArtifactLiveClose>;
  readonly closeReasons: string[] = [];
  private resolveClosed!: (value: EditableArtifactLiveClose) => void;
  private didClose = false;

  constructor(
    readonly index: number,
    private readonly transport: ScriptedTransport,
    private readonly plan: ConnectionPlan,
    readonly onMessage: (message: EditableArtifactLiveMessage) => void,
  ) {
    this.streamEpoch = `epoch-${index}`;
    this.limits = {
      maxClientFrameBytes: 8 * 1024 * 1024 + 64 * 1024,
      maxCommandBytes: EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
      maxIntentBytes: EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
      maxCommittedTransactionBytes: 8 * 1024 * 1024,
      maxSnapshotBytes: 64 * 1024 * 1024,
      maxInFlightTransactions: 256,
      maxInFlightBytes: 64 * 1024 * 1024,
      ...plan.limits,
    };
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  async readBootstrap(): Promise<EditableArtifactBootstrap> {
    this.transport.order.push(`bootstrap:${this.index}`);
    return typeof this.plan.bootstrap === "function" ? this.plan.bootstrap() : this.plan.bootstrap;
  }

  async replay(input: {
    after: number;
    through: number;
    limit: number;
  }): Promise<EditableArtifactReplayPage> {
    this.transport.replays.push({ after: input.after, through: input.through });
    return {
      artifactId: ARTIFACT_ID,
      transactions: this.transport.history
        .filter(
          (transaction) =>
            transaction.endSequence > input.after && transaction.endSequence <= input.through,
        )
        .sort((left, right) => left.startSequence - right.startSequence)
        .slice(0, input.limit),
      headSequence: this.transport.head,
    };
  }

  async submit(input: {
    transaction: EditableArtifactPendingTransaction;
  }): Promise<EditableArtifactSubmitReceipt> {
    this.transport.submissions.push(clonePending(input.transaction));
    if (!this.transport.onSubmit) throw new Error("unexpected submit");
    return await this.transport.onSubmit(input.transaction, this.index);
  }

  async acknowledge(input: { sequence: number; stateHash: string }): Promise<void> {
    this.transport.acknowledgements.push({ ...input });
  }

  push(message: EditableArtifactLiveMessage): void {
    this.onMessage(message);
  }

  close(reason = "closed"): void {
    this.closeReasons.push(reason);
    if (this.didClose) return;
    this.didClose = true;
    this.resolveClosed({
      reason:
        reason === "permission_changed"
          ? "permission_changed"
          : reason === "ticket_expired"
            ? "ticket_expired"
            : "closed",
    });
  }
}

class ScriptedTransport implements EditableArtifactSyncTransport {
  readonly order: string[] = [];
  readonly tickets: Array<{ artifactId: string; replicaId: string }> = [];
  readonly connections: DeferredConnection[] = [];
  readonly replays: Array<{ after: number; through: number }> = [];
  readonly acknowledgements: Array<{ sequence: number; stateHash: string }> = [];
  readonly submissions: EditableArtifactPendingTransaction[] = [];
  readonly history: EditableArtifactCommittedTransaction[] = [];
  onSubmit:
    | ((
        transaction: EditableArtifactPendingTransaction,
        connectionIndex: number,
      ) => Promise<EditableArtifactSubmitReceipt>)
    | null = null;

  constructor(private readonly plans: ConnectionPlan[]) {}

  get head(): number {
    return Math.max(0, ...this.history.map((transaction) => transaction.endSequence));
  }

  async mintTicket(
    input: Parameters<EditableArtifactSyncTransport["mintTicket"]>[0],
  ): Promise<EditableArtifactSyncTicket> {
    this.order.push(`ticket:${this.tickets.length}`);
    this.tickets.push({ artifactId: input.artifactId, replicaId: input.replicaId });
    return {
      artifactId: input.artifactId,
      modality: "spreadsheet",
      replicaId: input.replicaId,
      token: `ticket-${this.tickets.length}`,
      expiresAt: new Date(NOW + 60_000).toISOString(),
      protocolVersion: 1,
    };
  }

  async openLive(input: {
    onMessage: (message: EditableArtifactLiveMessage) => void;
  }): Promise<EditableArtifactLiveConnection> {
    const index = this.connections.length;
    this.order.push(`open:${index}`);
    const plan = this.plans[index];
    if (!plan) throw new Error(`no connection plan ${index}`);
    const connection = new DeferredConnection(index, this, plan, input.onMessage);
    this.connections.push(connection);
    for (const message of plan.beforeBootstrap ?? []) input.onMessage(message);
    return connection;
  }
}

class MockKernel implements EditableArtifactWorkerKernel {
  stateHash = sha(100);
  readonly recovered: number[] = [];
  readonly reconciled: number[] = [];
  readonly loadedSnapshotBytes: number[] = [];
  pending: EditableArtifactPendingTransaction[] = [];
  blocked: EditableArtifactBlockedPending[] = [];
  reconcileGate: Promise<void> | null = null;
  failNextPendingProjection = false;

  async reset(): Promise<void> {
    this.stateHash = sha(100);
    this.pending = [];
  }

  async querySpreadsheetViewport(): ReturnType<
    EditableArtifactWorkerKernel["querySpreadsheetViewport"]
  > {
    throw new Error("projection query is not configured");
  }

  async querySpreadsheetMetadata(): ReturnType<
    EditableArtifactWorkerKernel["querySpreadsheetMetadata"]
  > {
    throw new Error("metadata query is not configured");
  }

  async queryDocument(): ReturnType<EditableArtifactWorkerKernel["queryDocument"]> {
    throw new Error("document query is not configured");
  }

  async queryPresentation(): ReturnType<EditableArtifactWorkerKernel["queryPresentation"]> {
    throw new Error("presentation query is not configured");
  }

  async loadSnapshot(value: EditableArtifactSnapshot) {
    this.loadedSnapshotBytes.push(value.bytes[0] ?? -1);
    this.stateHash = value.stateHash;
    return { stateHash: value.stateHash, digest: sha(value.bytes[0] ?? 0) };
  }

  async applyRecovered(transaction: EditableArtifactCommittedTransaction) {
    expect(transaction.priorStateHash).toBe(this.stateHash);
    this.recovered.push(transaction.endSequence);
    this.stateHash = transaction.stateHash;
    return { stateHash: this.stateHash };
  }

  async reconcileCommitted(
    transaction: EditableArtifactCommittedTransaction,
    remainingPending: readonly EditableArtifactPendingTransaction[],
  ) {
    expect(transaction.priorStateHash).toBe(this.stateHash);
    this.reconciled.push(transaction.endSequence);
    if (this.reconcileGate) await this.reconcileGate;
    this.stateHash = transaction.stateHash;
    this.pending = remainingPending.map(clonePending);
    return { stateHash: this.stateHash, blockedPending: this.blocked };
  }

  async replacePending(transactions: readonly EditableArtifactPendingTransaction[]) {
    if (this.failNextPendingProjection) {
      this.failNextPendingProjection = false;
      throw new Error("projection unavailable");
    }
    this.pending = transactions.map(clonePending);
    return { blockedPending: this.blocked };
  }

  async authorPending(
    input: Parameters<EditableArtifactWorkerKernel["authorPending"]>[0],
  ): Promise<EditableArtifactPendingTransaction> {
    const authored = testPending({
      artifactId: input.artifactId,
      clientTransactionId: input.clientTransactionId,
      protocolVersion: input.protocolVersion,
      modelSchemaVersion: input.modelSchemaVersion,
      commandVersion: input.commandVersion,
      replicaId: input.replicaId,
      replicaCounter: input.replicaCounter,
      previousLocalTransactionId: input.previousLocalTransactionId,
      observedHeadSequence: input.observedHeadSequence,
      causalBase: (input.causalBase ?? []).map((entry) => ({ ...entry })),
      selectiveUndoTargets: [...(input.selectiveUndoTargets ?? [])],
      commandBytes: input.commandBytes.slice(),
      createdAt: input.createdAt,
    });
    return authored;
  }
}

class CorruptOnceReplicaStorage extends MemoryEditableArtifactStorage {
  clearCount = 0;
  private corruptNextLoad = true;

  override async loadReplica(scope: EditableArtifactStorageScope) {
    if (this.corruptNextLoad) {
      this.corruptNextLoad = false;
      throw new TypeError("corrupt retained replica");
    }
    return await super.loadReplica(scope);
  }

  override async clearReplica(scope: EditableArtifactStorageScope): Promise<void> {
    this.clearCount += 1;
    await super.clearReplica(scope);
  }
}

const scheduler: EditableArtifactSyncScheduler = {
  now: () => NOW,
  sleep: async (_delay, signal) => {
    if (signal.aborted) return;
    await Promise.resolve();
  },
};

function controllerOptions(
  transport: EditableArtifactSyncTransport,
  kernel = new MockKernel(),
  storage = new MemoryEditableArtifactStorage(),
  overrides: Partial<CreateEditableArtifactSyncControllerOptions> = {},
): CreateEditableArtifactSyncControllerOptions {
  return {
    artifactId: ARTIFACT_ID,
    modality: "spreadsheet",
    storageAuthority: {
      deploymentOrigin: "https://host.test",
      accountId: "account",
      workspaceId: "workspace",
      principalId: "principal",
      authorizationEpoch: "auth-epoch-1",
    },
    transport,
    kernel,
    storage,
    kernelVersion: KERNEL_VERSION,
    modelSchemaVersion: MODEL_SCHEMA_VERSION,
    commandVersion: 1,
    writerReplicaIdFactory: () => "2222222222222222",
    scheduler,
    reconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    ...overrides,
  };
}

async function waitFor(
  controller: EditableArtifactSyncController,
  predicate: (controller: EditableArtifactSyncController) => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = performance.now();
  while (!predicate(controller)) {
    if (performance.now() - started > timeoutMs) {
      throw new Error(`timed out waiting; state=${JSON.stringify(controller.getView())}`);
    }
    await Bun.sleep(1);
  }
}

function clonePending(
  value: EditableArtifactPendingTransaction,
): EditableArtifactPendingTransaction {
  return value.modality === "spreadsheet"
    ? {
        ...value,
        causalBase: value.causalBase.map((entry) => ({ ...entry })),
        selectiveUndoTargets: [...value.selectiveUndoTargets],
        commandBytes: value.commandBytes.slice(),
        intentBytes: value.intentBytes.slice(),
      }
    : {
        ...value,
        commandBytes: value.commandBytes.slice(),
        intentBytes: value.intentBytes.slice(),
      };
}

function retainedPending(input: {
  clientTransactionId: string;
  replicaId: string;
  replicaCounter?: number;
  previousLocalTransactionId?: string | null;
  protocolVersion?: number;
  modelSchemaVersion?: number;
  commandVersion?: number;
  createdAt?: number;
}): EditableArtifactPendingTransaction {
  const replicaCounter = input.replicaCounter ?? 1;
  return testPending({
    artifactId: ARTIFACT_ID,
    clientTransactionId: input.clientTransactionId,
    protocolVersion: input.protocolVersion ?? 1,
    modelSchemaVersion: input.modelSchemaVersion ?? MODEL_SCHEMA_VERSION,
    commandVersion: input.commandVersion ?? 1,
    replicaId: input.replicaId,
    replicaCounter,
    previousLocalTransactionId: input.previousLocalTransactionId ?? null,
    observedHeadSequence: 0,
    causalBase: [],
    selectiveUndoTargets: [],
    commandBytes: testCommand(replicaCounter),
    createdAt: input.createdAt ?? replicaCounter,
  });
}

describe("editable artifact sync controller", () => {
  test("cannot configure a command ceiling above the shared wire contract", () => {
    const transport = new ScriptedTransport([]);
    expect(() =>
      createEditableArtifactSyncController(
        controllerOptions(transport, undefined, undefined, {
          maxCommandBytes: EDITABLE_ARTIFACT_COMMAND_MAX_BYTES + 1,
        }),
      ),
    ).toThrow("maxCommandBytes exceeds the editable-artifact contract bound");
  });

  test("rejects a negotiated intent overflow before growing the durable WAL", async () => {
    const transport = new ScriptedTransport([
      {
        bootstrap: bootstrap(0, { snapshot: snapshot(0) }),
        limits: { maxIntentBytes: 1 },
      },
    ]);
    const storage = new MemoryEditableArtifactStorage();
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, new MockKernel(), storage),
    );
    await controller.whenLive();
    await expect(controller.queueCommands({ commandBytes: testCommand(1) })).rejects.toThrow(
      "intentBytes exceeds the negotiated live bound",
    );
    expect(await storage.listPending(STORAGE_SCOPE)).toEqual([]);
    await controller.close();
  });

  test("rebuilds a malformed confirmed cache from authority", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0), resyncRequired: true }) },
    ]);
    const storage = new CorruptOnceReplicaStorage();
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, new MockKernel(), storage),
    );

    await controller.whenLive();

    expect(storage.clearCount).toBe(1);
    expect(controller.getView()).toMatchObject({ state: "live", cursor: 0 });
    expect(await storage.loadReplica(STORAGE_SCOPE)).not.toBeNull();
    await controller.close();
  });

  test("subscribes before bootstrap, then closes live gaps and drops reorder/duplicates", async () => {
    const one = committed(1);
    const two = committed(2);
    const three = committed(3);
    const transport = new ScriptedTransport([
      {
        bootstrap: bootstrap(1, { snapshot: snapshot(0) }),
        beforeBootstrap: [
          { type: "transaction.committed", transaction: three },
          { type: "transaction.committed", transaction: one },
        ],
      },
    ]);
    transport.history.push(one, two, three);
    const kernel = new MockKernel();
    const controller = createEditableArtifactSyncController(controllerOptions(transport, kernel));

    await controller.whenLive();
    await waitFor(controller, (value) => value.getView().cursor === 3);

    expect(transport.order.slice(0, 3)).toEqual(["ticket:0", "open:0", "bootstrap:0"]);
    expect(kernel.recovered).toEqual([1]);
    expect(kernel.reconciled).toEqual([2, 3]);
    expect(transport.replays).toEqual([
      { after: 0, through: 1 },
      { after: 1, through: 2 },
      { after: 2, through: 3 },
    ]);
    await controller.close();
  });

  test("uses a head watermark to recover a lost final notification", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    const controller = createEditableArtifactSyncController(controllerOptions(transport));
    await controller.whenLive();
    transport.history.push(committed(1), committed(2));
    transport.connections[0]!.push({ type: "head", artifactId: ARTIFACT_ID, headSequence: 2 });
    await waitFor(controller, (value) => value.getView().cursor === 2);
    expect(transport.replays).toContainEqual({ after: 0, through: 2 });
    await controller.close();
  });

  test("consumes a newer durable head reported while replaying", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(1, { snapshot: snapshot(0) }) },
    ]);
    transport.history.push(committed(1), committed(2));
    const controller = createEditableArtifactSyncController(controllerOptions(transport));

    await controller.whenLive();

    expect(controller.getView()).toMatchObject({ cursor: 2, headSequence: 2 });
    expect(transport.replays).toEqual([
      { after: 0, through: 1 },
      { after: 1, through: 2 },
    ]);
    await controller.close();
  });

  test("reconnects from its verified cursor and replays a contiguous durable tail", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(1, { snapshot: snapshot(0) }) },
      { bootstrap: bootstrap(3) },
    ]);
    transport.history.push(committed(1), committed(2), committed(3));
    const controller = createEditableArtifactSyncController(controllerOptions(transport));
    await controller.whenLive();
    transport.connections[0]!.close();
    await waitFor(
      controller,
      (value) => transport.connections.length === 2 && value.getView().cursor === 3,
    );
    expect(transport.tickets).toHaveLength(2);
    expect(transport.replays).toContainEqual({ after: 1, through: 3 });
    await controller.close();
  });

  test("resets reconnect budget after every healthy live barrier", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
      { bootstrap: bootstrap(0) },
      { bootstrap: bootstrap(0) },
    ]);
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, new MockKernel(), new MemoryEditableArtifactStorage(), {
        maxReconnectAttempts: 1,
      }),
    );
    await controller.whenLive();

    transport.connections[0]!.close();
    await waitFor(
      controller,
      (value) => transport.connections.length === 2 && value.getView().state === "live",
    );
    expect(controller.getView().reconnectAttempt).toBe(0);
    transport.connections[1]!.close();
    await waitFor(
      controller,
      (value) => transport.connections.length === 3 && value.getView().state === "live",
    );
    expect(controller.getView().reconnectAttempt).toBe(0);
    await controller.close();
  });

  test("projects an authoritative rollback without retaining a stale head", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(3, { snapshot: snapshot(0) }) },
      {
        bootstrap: bootstrap(1, {
          snapshot: snapshot(1),
          resyncRequired: true,
        }),
      },
    ]);
    transport.history.push(committed(1), committed(2), committed(3));
    const controller = createEditableArtifactSyncController(controllerOptions(transport));
    await controller.whenLive();
    expect(controller.getView()).toMatchObject({ cursor: 3, headSequence: 3 });

    transport.history.splice(1);
    transport.connections[0]!.close();
    await waitFor(
      controller,
      (value) =>
        transport.connections.length === 2 &&
        value.getView().state === "live" &&
        value.getView().cursor === 1,
    );

    expect(controller.getView()).toMatchObject({ cursor: 1, headSequence: 1 });
    await controller.close();
  });

  test("retries an unknown submit outcome with byte-identical causal identity", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
      { bootstrap: bootstrap(0) },
    ]);
    let attempts = 0;
    transport.onSubmit = async (pending) => {
      attempts += 1;
      if (attempts === 1) {
        throw new EditableArtifactTransportError("response lost", { outcomeUnknown: true });
      }
      const transaction = committed(1, {
        requestHash: pending.requestHash,
      });
      transport.history.push(transaction);
      return receipt(pending, transaction);
    };
    const storage = new MemoryEditableArtifactStorage();
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, new MockKernel(), storage),
    );
    await controller.whenLive();
    const queued = await controller.queueCommands({
      clientTransactionId: "33333333-3333-4333-8333-333333333333",
      commandBytes: testCommand(new Uint8Array([7, 8, 9])),
    });
    await waitFor(controller, (value) => value.getView().cursor === 1);

    expect(transport.submissions).toHaveLength(2);
    expect(transport.submissions[0]).toEqual(transport.submissions[1]);
    expect(transport.submissions[1]).toMatchObject({
      clientTransactionId: queued.clientTransactionId,
      replicaId: "2222222222222222",
      replicaCounter: 1,
      previousLocalTransactionId: null,
    });
    expect(controller.getView().pendingTransactions).toBe(0);
    await controller.close();
  });

  test("settles WAL only after authority maps client identity to the committed server id", async () => {
    let resolveReceipt!: (value: EditableArtifactSubmitReceipt) => void;
    const receiptPromise = new Promise<EditableArtifactSubmitReceipt>((resolve) => {
      resolveReceipt = resolve;
    });
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    transport.onSubmit = async () => await receiptPromise;
    const storage = new MemoryEditableArtifactStorage();
    const kernel = new MockKernel();
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, kernel, storage),
    );
    await controller.whenLive();
    const pending = await controller.queueCommands({ commandBytes: testCommand(1) });
    await waitFor(controller, () => transport.submissions.length === 1);
    const transaction = committed(1, { requestHash: pending.requestHash });

    // A matching hash and committed frame are not identity authority. The WAL
    // remains until mutationAccepted/submit receipt proves the ID mapping.
    transport.connections[0]!.push({ type: "transaction.committed", transaction });
    await waitFor(controller, (value) => value.getView().cursor === 1);
    expect(controller.getView().pendingTransactions).toBe(1);
    expect(await storage.listPending(STORAGE_SCOPE)).toHaveLength(1);
    // The matching spreadsheet dot is omitted only from speculative replay;
    // identity and WAL ownership still wait for mutationAccepted below.
    expect(kernel.pending).toEqual([]);

    resolveReceipt(receipt(pending, transaction));
    await waitFor(controller, (value) => value.getView().pendingTransactions === 0);
    expect(await storage.listPending(STORAGE_SCOPE)).toEqual([]);
    await controller.close();
  });

  test("ignores a retired submit rejection after its successor is live", async () => {
    let rejectRetired!: (error: Error) => void;
    const retiredSubmit = new Promise<EditableArtifactSubmitReceipt>((_resolve, reject) => {
      rejectRetired = reject;
    });
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
      { bootstrap: bootstrap(0) },
    ]);
    transport.onSubmit = async (pending, connectionIndex) => {
      if (connectionIndex === 0) return await retiredSubmit;
      const transaction = committed(1, {
        requestHash: pending.requestHash,
      });
      transport.history.push(transaction);
      return receipt(pending, transaction);
    };
    const controller = createEditableArtifactSyncController(controllerOptions(transport));
    await controller.whenLive();
    await controller.queueCommands({ commandBytes: testCommand(1) });
    await waitFor(controller, () => transport.submissions.length === 1);

    transport.connections[0]!.close();
    await waitFor(
      controller,
      (value) =>
        transport.connections.length === 2 &&
        value.getView().state === "live" &&
        value.getView().cursor === 1,
    );
    rejectRetired(new EditableArtifactTransportError("retired socket rejected"));
    await Bun.sleep(5);

    expect(transport.connections).toHaveLength(2);
    expect(controller.getView()).toMatchObject({ state: "live", cursor: 1 });
    await controller.close();
  });

  test("rejects a submit receipt whose committed identity differs from its envelope", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    transport.onSubmit = async (pending) => ({
      artifactId: ARTIFACT_ID,
      clientTransactionId: pending.clientTransactionId,
      transactionId: committed(1).transactionId,
      requestHash: pending.requestHash,
      committed: committed(1),
    });
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, new MockKernel(), new MemoryEditableArtifactStorage(), {
        maxReconnectAttempts: 0,
      }),
    );
    await controller.whenLive();
    await controller.queueCommands({ commandBytes: testCommand(1) });
    await waitFor(controller, (value) => value.getView().state === "failed");

    expect(controller.getView()).toMatchObject({
      state: "failed",
      cursor: 0,
      pendingTransactions: 1,
    });
    await controller.close();
  });

  test("preserves pending intent and read sync when edit permission is removed", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0), writable: true }) },
      { bootstrap: bootstrap(0, { writable: false }) },
    ]);
    const controller = createEditableArtifactSyncController(controllerOptions(transport));
    await controller.whenLive();
    transport.connections[0]!.close("permission_changed");
    await waitFor(
      controller,
      (value) => transport.connections.length === 2 && value.getView().state === "live",
    );
    await controller.queueCommands({ commandBytes: testCommand(1) });
    await Bun.sleep(5);
    expect(controller.getView()).toMatchObject({ writable: false, pendingTransactions: 1 });
    expect(transport.submissions).toHaveLength(0);
    await controller.close();
  });

  test("keeps reads live across submit permission loss and retries after authorization returns", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0), writable: true }) },
    ]);
    let attempts = 0;
    transport.onSubmit = async (pending) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("edit permission denied"), {
          code: "permission_changed",
        });
      }
      const transaction = committed(1, {
        requestHash: pending.requestHash,
      });
      transport.history.push(transaction);
      return receipt(pending, transaction);
    };
    const controller = createEditableArtifactSyncController(controllerOptions(transport));
    await controller.whenLive();
    await controller.queueCommands({ commandBytes: testCommand(1) });
    await waitFor(controller, (value) => !value.getView().writable);

    expect(controller.getView()).toMatchObject({ state: "live", pendingTransactions: 1 });
    expect(transport.connections).toHaveLength(1);
    transport.connections[0]!.push({
      type: "authorization",
      artifactId: ARTIFACT_ID,
      writable: true,
    });
    await waitFor(controller, (value) => value.getView().cursor === 1);

    expect(attempts).toBe(2);
    expect(controller.getView()).toMatchObject({ state: "live", writable: true });
    await controller.close();
  });

  test("blocks one definitive submit rejection without tearing down read sync", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    transport.onSubmit = async () => {
      throw Object.assign(new Error("intent rejected"), { code: "invalid_intent" });
    };
    const controller = createEditableArtifactSyncController(controllerOptions(transport));
    await controller.whenLive();
    const pending = await controller.queueCommands({ commandBytes: testCommand(1) });
    await waitFor(controller, (value) => value.getView().blockedPending.length === 1);

    expect(controller.getView()).toMatchObject({
      state: "live",
      pendingTransactions: 1,
      blockedPending: [
        { clientTransactionId: pending.clientTransactionId, code: "invalid_intent" },
      ],
    });
    expect(transport.connections).toHaveLength(1);
    await controller.close();
  });

  test("submits one causal writer chain in order without rewriting predecessor identity", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    let sequence = 0;
    transport.onSubmit = async (pending) => {
      sequence += 1;
      if (sequence === 1) await firstGate;
      const transaction = committed(sequence, {
        requestHash: pending.requestHash,
      });
      transport.history.push(transaction);
      return receipt(pending, transaction);
    };
    const controller = createEditableArtifactSyncController(controllerOptions(transport));
    await controller.whenLive();
    const first = await controller.queueCommands({
      clientTransactionId: "11111111-1111-4111-8111-111111111111",
      commandBytes: testCommand(1),
    });
    await waitFor(controller, () => transport.submissions.length === 1);
    const second = await controller.queueCommands({
      clientTransactionId: "22222222-2222-4222-8222-222222222222",
      commandBytes: testCommand(2),
    });
    expect(second.previousLocalTransactionId).toBe(first.clientTransactionId);
    expect(second.replicaCounter).toBe(2);
    expect(transport.submissions).toHaveLength(1);
    releaseFirst();
    await waitFor(controller, (value) => value.getView().cursor === 2);
    expect(transport.submissions.map((value) => value.clientTransactionId)).toEqual([
      first.clientTransactionId,
      second.clientTransactionId,
    ]);
    expect(transport.submissions[1]?.previousLocalTransactionId).toBe(first.clientTransactionId);
    await controller.close();
  });

  test("keeps a locally invalid speculative transaction blocked without stopping read sync", async () => {
    const transactionId = "44444444-4444-4444-8444-444444444444";
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    const kernel = new MockKernel();
    const controller = createEditableArtifactSyncController(controllerOptions(transport, kernel));
    await controller.whenLive();
    kernel.blocked = [{ clientTransactionId: transactionId, code: "missing_target" }];
    await controller.queueCommands({
      clientTransactionId: transactionId,
      commandBytes: testCommand(1),
    });
    await Bun.sleep(5);
    expect(controller.getView()).toMatchObject({
      state: "live",
      pendingTransactions: 1,
      blockedPending: [{ clientTransactionId: transactionId, code: "missing_target" }],
    });
    expect(transport.submissions).toHaveLength(0);
    await controller.close();
  });

  test("keeps a command accepted after WAL persistence when projection must rebuild", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0), writable: false }) },
      {
        bootstrap: bootstrap(0, {
          snapshot: snapshot(0),
          writable: false,
          resyncRequired: true,
        }),
      },
    ]);
    const kernel = new MockKernel();
    const storage = new MemoryEditableArtifactStorage();
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, kernel, storage),
    );
    await controller.whenLive();
    kernel.failNextPendingProjection = true;

    const accepted = await controller.queueCommands({ commandBytes: testCommand(1) });

    expect((await storage.listPending(STORAGE_SCOPE))[0]?.clientTransactionId).toBe(
      accepted.clientTransactionId,
    );
    await waitFor(
      controller,
      (value) => transport.connections.length === 2 && value.getView().state === "live",
    );
    expect(controller.getView().pendingTransactions).toBe(1);
    await controller.close();
  });

  test("bounds a slow worker queue and restarts from a verified snapshot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
      { bootstrap: bootstrap(4, { snapshot: snapshot(4), resyncRequired: true }) },
    ]);
    const kernel = new MockKernel();
    kernel.reconcileGate = gate;
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, kernel, new MemoryEditableArtifactStorage(), {
        maxQueuedMessages: 2,
      }),
    );
    await controller.whenLive();
    transport.connections[0]!.push({ type: "transaction.committed", transaction: committed(1) });
    await waitFor(controller, () => kernel.reconciled.length === 1);
    transport.connections[0]!.push({ type: "transaction.committed", transaction: committed(2) });
    transport.connections[0]!.push({ type: "transaction.committed", transaction: committed(3) });
    transport.connections[0]!.push({ type: "transaction.committed", transaction: committed(4) });
    release();
    kernel.reconcileGate = null;

    await waitFor(
      controller,
      (value) => transport.connections.length === 2 && value.getView().cursor === 4,
    );
    expect(kernel.loadedSnapshotBytes).toEqual([1, 5]);
    await controller.close();
  });

  test("rejects a corrupted snapshot digest and recovers from fresh authoritative bytes", async () => {
    const corrupt = snapshot(0);
    corrupt.bytes = new Uint8Array([9]);
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: corrupt }) },
      { bootstrap: bootstrap(0, { snapshot: snapshot(0), resyncRequired: true }) },
    ]);
    const kernel = new MockKernel();
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, kernel, new MemoryEditableArtifactStorage(), {
        maxReconnectAttempts: 1,
      }),
    );
    await controller.whenLive();
    expect(kernel.loadedSnapshotBytes).toEqual([9, 1]);
    expect(transport.connections).toHaveLength(2);
    expect(transport.connections[0]?.closeReasons).toContain("client_reconnect");
    await controller.close();
  });

  test("rejects an oversized hostile live transaction and full-resyncs", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
      { bootstrap: bootstrap(1, { snapshot: snapshot(1), resyncRequired: true }) },
    ]);
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, new MockKernel(), new MemoryEditableArtifactStorage(), {
        maxCommittedTransactionBytes: 1,
      }),
    );
    await controller.whenLive();
    transport.connections[0]!.push({
      type: "transaction.committed",
      transaction: committed(1, { committedTransactionBytes: new Uint8Array([1, 2]) }),
    });
    await waitFor(
      controller,
      (value) => transport.connections.length === 2 && value.getView().cursor === 1,
    );
    expect(controller.getView().state).toBe("live");
    await controller.close();
  });

  test("fails closed on an expired ticket before opening a live transport", async () => {
    const transport = new ScriptedTransport([]);
    transport.mintTicket = async (input) => ({
      artifactId: input.artifactId,
      modality: "spreadsheet",
      replicaId: input.replicaId,
      token: "expired",
      expiresAt: new Date(NOW - 1).toISOString(),
      protocolVersion: 1,
    });
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, new MockKernel(), new MemoryEditableArtifactStorage(), {
        maxReconnectAttempts: 0,
      }),
    );
    await expect(controller.whenLive()).rejects.toThrow("gave up after 0 reconnect attempts");
    expect(transport.connections).toHaveLength(0);
    await controller.close();
  });

  test("close settles a pending whenLive waiter", async () => {
    const transport = new ScriptedTransport([]);
    transport.mintTicket = async (input) =>
      await new Promise<EditableArtifactSyncTicket>((_resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(new EditableArtifactTransportError("aborted")),
          { once: true },
        );
      });
    const controller = createEditableArtifactSyncController(controllerOptions(transport));
    const live = controller.whenLive();
    await Bun.sleep(1);
    await controller.close();
    await expect(live).rejects.toThrow("closed");
  });

  test("pool reuses one controller and socket per artifact until the last lease releases", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    const pool = new EditableArtifactSyncPool((artifactId) => ({
      ...controllerOptions(transport),
      artifactId,
    }));
    const first = pool.acquire(ARTIFACT_ID);
    const second = pool.acquire(ARTIFACT_ID);
    expect(first.controller).toBe(second.controller);
    await first.controller.whenLive();
    expect(transport.connections).toHaveLength(1);
    first.release();
    expect(pool.size).toBe(1);
    second.release();
    await waitFor(first.controller, (value) => value.getView().state === "closed");
    expect(pool.size).toBe(0);
  });

  test("pool preserves its single controller across a same-task release and reacquire", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    const pool = new EditableArtifactSyncPool((artifactId) => ({
      ...controllerOptions(transport),
      artifactId,
    }));
    const first = pool.acquire(ARTIFACT_ID);
    await first.controller.whenLive();
    first.release();
    const second = pool.acquire(ARTIFACT_ID);
    await Promise.resolve();
    expect(second.controller).toBe(first.controller);
    expect(transport.connections).toHaveLength(1);
    second.release();
    await waitFor(second.controller, (value) => value.getView().state === "closed");
  });

  test("pool never reuses a controller across principal or authorization epochs", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    let principalId = "principal-a";
    let authorizationEpoch = "login-1";
    const pool = new EditableArtifactSyncPool((artifactId) => ({
      ...controllerOptions(transport),
      artifactId,
      storageAuthority: {
        deploymentOrigin: "https://host.test",
        accountId: "account",
        workspaceId: "workspace",
        principalId,
        authorizationEpoch,
      },
    }));
    const first = pool.acquire(ARTIFACT_ID);
    await first.controller.whenLive();
    principalId = "principal-b";
    authorizationEpoch = "login-2";
    const second = pool.acquire(ARTIFACT_ID);
    await second.controller.whenLive();
    expect(second.controller).not.toBe(first.controller);
    expect(transport.connections).toHaveLength(2);
    expect(pool.size).toBe(2);
    first.release();
    second.release();
    await Promise.all([
      waitFor(first.controller, (value) => value.getView().state === "closed"),
      waitFor(second.controller, (value) => value.getView().state === "closed"),
    ]);
  });

  test("two tabs cannot accidentally share a writer replica", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const firstTransport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    const secondTransport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    const first = createEditableArtifactSyncController(
      controllerOptions(firstTransport, new MockKernel(), storage, {
        writerReplicaIdFactory: () => "aaaaaaaaaaaaaaaa",
      }),
    );
    const second = createEditableArtifactSyncController(
      controllerOptions(secondTransport, new MockKernel(), storage, {
        writerReplicaIdFactory: () => "bbbbbbbbbbbbbbbb",
      }),
    );
    await Promise.all([first.whenLive(), second.whenLive()]);
    expect(firstTransport.tickets[0]?.replicaId).toBe("aaaaaaaaaaaaaaaa");
    expect(secondTransport.tickets[0]?.replicaId).toBe("bbbbbbbbbbbbbbbb");
    await Promise.all([first.close(), second.close()]);
  });

  test("replays retained intent under its bound replica, then rotates to a fresh writer", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const originalTransport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0), writable: false }) },
    ]);
    const original = createEditableArtifactSyncController(
      controllerOptions(originalTransport, new MockKernel(), storage, {
        writerReplicaIdFactory: () => "aaaaaaaaaaaaaaaa",
      }),
    );
    await original.whenLive();
    const retained = await original.queueCommands({ commandBytes: testCommand(1) });
    await original.close();

    const recoveryTransport = new ScriptedTransport([
      { bootstrap: bootstrap(0) },
      { bootstrap: bootstrap(1) },
    ]);
    recoveryTransport.onSubmit = async (pending) => {
      const transaction = committed(1, {
        requestHash: pending.requestHash,
      });
      recoveryTransport.history.push(transaction);
      return receipt(pending, transaction);
    };
    const recovered = createEditableArtifactSyncController(
      controllerOptions(recoveryTransport, new MockKernel(), storage, {
        writerReplicaIdFactory: () => "bbbbbbbbbbbbbbbb",
      }),
    );
    await recovered.whenLive();
    await waitFor(
      recovered,
      (controller) =>
        recoveryTransport.tickets.length === 2 &&
        controller.getView().cursor === 1 &&
        controller.getView().state === "live",
    );
    expect(recoveryTransport.tickets.map((ticket) => ticket.replicaId)).toEqual([
      "aaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
    ]);
    expect(recoveryTransport.submissions.map((pending) => pending.clientTransactionId)).toEqual([
      retained.clientTransactionId,
    ]);
    await recovered.close();
  });

  test("returns a retained deterministic WAL retry after writer rotation", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const transactionId = "77777777-7777-4777-8777-777777777777";
    const originalTransport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0), writable: false }) },
    ]);
    const original = createEditableArtifactSyncController(
      controllerOptions(originalTransport, new MockKernel(), storage, {
        writerReplicaIdFactory: () => "aaaaaaaaaaaaaaaa",
      }),
    );
    await original.whenLive();
    const first = await original.queueCommands({
      clientTransactionId: transactionId,
      commandBytes: testCommand(7),
    });
    await original.close();

    const retryTransport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { writable: false }) },
    ]);
    const retried = createEditableArtifactSyncController(
      controllerOptions(retryTransport, new MockKernel(), storage, {
        writerReplicaIdFactory: () => "bbbbbbbbbbbbbbbb",
      }),
    );
    await retried.whenLive();
    const retry = await retried.queueCommands({
      clientTransactionId: transactionId,
      commandBytes: testCommand(7),
    });

    expect(retry).toEqual(first);
    expect(retry.replicaId).toBe("aaaaaaaaaaaaaaaa");
    await retried.close();
  });

  test("reconnects to a retained WAL replica when a deterministic host retry unblocks it", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const transactionId = "77777777-7777-4777-8777-777777777777";
    const originalTransport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0), writable: false }) },
    ]);
    const original = createEditableArtifactSyncController(
      controllerOptions(originalTransport, new MockKernel(), storage, {
        writerReplicaIdFactory: () => "aaaaaaaaaaaaaaaa",
      }),
    );
    await original.whenLive();
    const retained = await original.queueCommands({
      clientTransactionId: transactionId,
      commandBytes: testCommand(7),
    });
    await original.close();

    const recoveryTransport = new ScriptedTransport([
      { bootstrap: bootstrap(0) },
      { bootstrap: bootstrap(0) },
      { bootstrap: bootstrap(1) },
    ]);
    recoveryTransport.onSubmit = async (pending) => {
      const transaction = committed(1, {
        requestHash: pending.requestHash,
      });
      recoveryTransport.history.push(transaction);
      return receipt(pending, transaction);
    };
    const kernel = new MockKernel();
    kernel.blocked = [{ clientTransactionId: transactionId, code: "missing_target" }];
    const recovered = createEditableArtifactSyncController(
      controllerOptions(recoveryTransport, kernel, storage, {
        writerReplicaIdFactory: () => "bbbbbbbbbbbbbbbb",
      }),
    );
    await recovered.whenLive();
    expect(recoveryTransport.tickets.map((ticket) => ticket.replicaId)).toEqual([
      "bbbbbbbbbbbbbbbb",
    ]);

    kernel.blocked = [];
    const retry = await recovered.queueCommands({
      clientTransactionId: transactionId,
      commandBytes: testCommand(7),
    });
    await waitFor(
      recovered,
      (controller) =>
        recoveryTransport.tickets.length === 3 &&
        controller.getView().state === "live" &&
        controller.getView().cursor === 1,
    );

    expect(retry).toEqual(retained);
    expect(recoveryTransport.tickets.map((ticket) => ticket.replicaId)).toEqual([
      "bbbbbbbbbbbbbbbb",
      "aaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
    ]);
    expect(recoveryTransport.submissions).toEqual([retained]);
    await recovered.close();
  });

  test("fails closed on retained pending protocol drift", async () => {
    const storage = new MemoryEditableArtifactStorage();
    await storage.putPending(
      STORAGE_SCOPE,
      retainedPending({
        clientTransactionId: "88888888-8888-4888-8888-888888888888",
        replicaId: "aaaaaaaaaaaaaaaa",
        protocolVersion: 2,
      }),
    );
    const controller = createEditableArtifactSyncController(
      controllerOptions(new ScriptedTransport([]), new MockKernel(), storage),
    );

    await expect(controller.whenLive()).rejects.toBeInstanceOf(EditableArtifactSyncError);
    expect(controller.getView().state).toBe("unsupported");
    await controller.close();
  });

  test("connects through an independent pending replica when the earliest one is blocked", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const blockedId = "99999999-9999-4999-8999-999999999999";
    await storage.putPending(
      STORAGE_SCOPE,
      retainedPending({
        clientTransactionId: blockedId,
        replicaId: "aaaaaaaaaaaaaaaa",
        createdAt: 1,
      }),
    );
    await storage.putPending(
      STORAGE_SCOPE,
      retainedPending({
        clientTransactionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        replicaId: "bbbbbbbbbbbbbbbb",
        createdAt: 2,
      }),
    );
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0), writable: false }) },
      { bootstrap: bootstrap(0, { writable: false }) },
    ]);
    const kernel = new MockKernel();
    kernel.blocked = [{ clientTransactionId: blockedId, code: "missing_target" }];
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, kernel, storage),
    );

    await controller.whenLive();

    await waitFor(
      controller,
      (value) => transport.tickets.length === 2 && value.getView().state === "live",
    );

    expect(transport.tickets.map((ticket) => ticket.replicaId)).toEqual([
      "aaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
    ]);
    expect(controller.getView().blockedPending).toContainEqual({
      clientTransactionId: blockedId,
      code: "missing_target",
    });
    await controller.close();
  });

  test("rotates past a definitively rejected recovery replica without starving another", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const rejectedId = "99999999-9999-4999-8999-999999999999";
    const acceptedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await storage.putPending(
      STORAGE_SCOPE,
      retainedPending({
        clientTransactionId: rejectedId,
        replicaId: "aaaaaaaaaaaaaaaa",
        createdAt: 1,
      }),
    );
    await storage.putPending(
      STORAGE_SCOPE,
      retainedPending({
        clientTransactionId: acceptedId,
        replicaId: "bbbbbbbbbbbbbbbb",
        createdAt: 2,
      }),
    );
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
      { bootstrap: bootstrap(0) },
      { bootstrap: bootstrap(1) },
    ]);
    transport.onSubmit = async (pending) => {
      if (pending.clientTransactionId === rejectedId) {
        throw Object.assign(new Error("recovery intent rejected"), {
          code: "invalid_intent",
        });
      }
      const transaction = committed(1, {
        requestHash: pending.requestHash,
      });
      transport.history.push(transaction);
      return receipt(pending, transaction);
    };
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, new MockKernel(), storage),
    );

    await controller.whenLive();
    await waitFor(
      controller,
      (value) =>
        transport.tickets.length === 3 &&
        value.getView().state === "live" &&
        value.getView().cursor === 1,
    );

    expect(transport.tickets.map((ticket) => ticket.replicaId)).toEqual([
      "aaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
      "2222222222222222",
    ]);
    expect(transport.submissions.map((pending) => pending.clientTransactionId)).toEqual([
      rejectedId,
      acceptedId,
    ]);
    expect(controller.getView().blockedPending).toContainEqual({
      clientTransactionId: rejectedId,
      code: "invalid_intent",
    });
    expect(controller.getView()).toMatchObject({ state: "live", pendingTransactions: 1 });
    await controller.close();
  });

  test("two tabs converge on one durable transaction without a storage race failure", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const firstTransport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    const secondTransport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    const first = createEditableArtifactSyncController(
      controllerOptions(firstTransport, new MockKernel(), storage, {
        writerReplicaIdFactory: () => "aaaaaaaaaaaaaaaa",
      }),
    );
    const second = createEditableArtifactSyncController(
      controllerOptions(secondTransport, new MockKernel(), storage, {
        writerReplicaIdFactory: () => "bbbbbbbbbbbbbbbb",
      }),
    );
    await Promise.all([first.whenLive(), second.whenLive()]);

    const transaction = committed(1);
    firstTransport.connections[0]!.push({ type: "transaction.committed", transaction });
    secondTransport.connections[0]!.push({ type: "transaction.committed", transaction });
    await Promise.all([
      waitFor(first, (controller) => controller.getView().cursor === 1),
      waitFor(second, (controller) => controller.getView().cursor === 1),
    ]);
    expect(first.getView().state).toBe("live");
    expect(second.getView().state).toBe("live");
    expect((await storage.loadReplica(STORAGE_SCOPE))?.tail).toHaveLength(1);
    await Promise.all([first.close(), second.close()]);
  });

  test("adopts a snapshot compacted by another tab while applying an older live transaction", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0) }) },
    ]);
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, new MockKernel(), storage),
    );
    await controller.whenLive();

    const compacted = snapshot(2);
    await storage.saveReplica(
      STORAGE_SCOPE,
      {
        artifactId: ARTIFACT_ID,
        modality: "spreadsheet",
        snapshot: compacted,
        tail: [],
        cursor: compacted.sequence,
        stateHash: compacted.stateHash,
        updatedAt: NOW + 1,
      },
      { cursor: 0, stateHash: sha(100) },
    );
    transport.connections[0]!.push({
      type: "transaction.committed",
      transaction: committed(1),
    });

    await waitFor(controller, (value) => value.getView().cursor === 2);
    expect(controller.getView().state).toBe("live");
    expect(
      transport.acknowledgements.some(
        (acknowledgement) =>
          acknowledgement.sequence === 2 && acknowledgement.stateHash === compacted.stateHash,
      ),
    ).toBe(true);
    await controller.close();
  });

  test("rejects pending overflow without growing its durable WAL", async () => {
    const storage = new MemoryEditableArtifactStorage();
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0), writable: false }) },
    ]);
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, new MockKernel(), storage, {
        maxPendingTransactions: 1,
      }),
    );
    await controller.whenLive();
    await controller.queueCommands({ commandBytes: testCommand(1) });
    await expect(controller.queueCommands({ commandBytes: testCommand(2) })).rejects.toThrow(
      "pending transaction count",
    );
    expect(controller.getView().pendingTransactions).toBe(1);
    await controller.close();
  });

  test("serializes concurrent authors into one gap-free causal chain", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0), writable: false }) },
    ]);
    const controller = createEditableArtifactSyncController(controllerOptions(transport));
    await controller.whenLive();
    const [first, second] = await Promise.all([
      controller.queueCommands({
        clientTransactionId: "11111111-1111-4111-8111-111111111111",
        commandBytes: testCommand(1),
      }),
      controller.queueCommands({
        clientTransactionId: "22222222-2222-4222-8222-222222222222",
        commandBytes: testCommand(2),
      }),
    ]);
    expect(first).toMatchObject({ replicaCounter: 1, previousLocalTransactionId: null });
    expect(second).toMatchObject({
      replicaCounter: 2,
      previousLocalTransactionId: first.clientTransactionId,
    });
    await controller.close();
  });

  test("does not consume causal identity when authored intent exceeds the WAL byte cap", async () => {
    const transport = new ScriptedTransport([
      { bootstrap: bootstrap(0, { snapshot: snapshot(0), writable: false }) },
    ]);
    const kernel = new MockKernel();
    const oversizedCommand = testCommand(new Uint8Array(128).fill(1));
    const controller = createEditableArtifactSyncController(
      controllerOptions(transport, kernel, new MemoryEditableArtifactStorage(), {
        maxPendingBytes: oversizedCommand.byteLength + 64,
      }),
    );
    await controller.whenLive();
    await expect(controller.queueCommands({ commandBytes: oversizedCommand })).rejects.toThrow(
      "pending transaction bytes",
    );
    const accepted = await controller.queueCommands({ commandBytes: testCommand(2) });
    expect(accepted).toMatchObject({ replicaCounter: 1, previousLocalTransactionId: null });
    await controller.close();
  });
});
