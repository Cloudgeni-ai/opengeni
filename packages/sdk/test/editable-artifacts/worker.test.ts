import { describe, expect, test } from "bun:test";
import {
  EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
  decodeEditableArtifactMutationIntent,
  decodeSpreadsheetMetadataKernelProjection,
  encodeSpreadsheetMetadataKernelProjection,
  hashEditableArtifactMutationIntentBytes,
} from "@opengeni/contracts/editable-artifacts";
import { decodeCommittedTransactionSummary } from "@opengeni/contracts/editable-artifact-committed-transaction";
import {
  createBrowserEditableArtifactWorkerKernel,
  type ArtifactWorkerClientEndpoint,
  type ArtifactWorkerClientErrorEvent,
  type ArtifactWorkerClientMessageEvent,
} from "../../src/editable-artifacts/worker/browser-client";
import type {
  ArtifactWorkerKernelAdapter,
  ArtifactWorkerKernelAdapterFactory,
  ArtifactWorkerKernelSession,
} from "../../src/editable-artifacts/worker/kernel-adapter";
import {
  ArtifactWorkerPendingProjectionError,
  loadBrowserWasmKernelAdapter,
} from "../../src/editable-artifacts/worker/kernel-adapter";
import {
  ArtifactWorkerBinaryWriter,
  ArtifactWorkerProtocolError,
  ArtifactWorkerRpcKind,
  decodeArtifactWorkerRpcMessage,
  encodeArtifactWorkerRpcMessage,
  ownedTransferBuffer,
  transferListForArtifactWorkerRpcMessage,
  type ArtifactWorkerRpcMessage,
} from "../../src/editable-artifacts/worker/rpc-protocol";
import {
  ArtifactWorkerRuntime,
  type ArtifactWorkerMessageEvent,
  type ArtifactWorkerRuntimeEndpoint,
} from "../../src/editable-artifacts/worker/runtime";
import { encodeInitialize, sha256Hex } from "../../src/editable-artifacts/worker/wire-codec";
import type {
  EditableArtifactCommittedTransaction,
  EditableArtifactSnapshot,
  EditableArtifactSpreadsheetSnapshot,
} from "../../src/editable-artifacts/types";
import { testCommand, testCommandFirstValue, testCommitted } from "./protocol-fixtures";

const ARTIFACT_ID = "10000000000000000000000000000000";
const REPLICA_ID = "0000000000000001";
const UNDO_OPERATION_ID = "20000000000000000000000000000000";
const ASSET_OPTIONS = {
  modality: "spreadsheet",
  kernelVersion: "kernel-test",
  protocolVersion: 1,
  modelSchemaVersion: 1,
  commandVersion: 1,
  applicationOrigin: "https://artifacts.test",
  workerUrl: "https://artifacts.test/worker.js",
  wasmGlueUrl: "https://artifacts.test/kernel.js",
  wasmBinaryUrl: "https://artifacts.test/kernel.wasm",
} as const;
const INITIALIZE_OPTIONS = {
  modality: "spreadsheet",
  kernelVersion: "kernel-test",
  protocolVersion: 1,
  modelSchemaVersion: 1,
  commandVersion: 1,
  wasmGlueUrl: ASSET_OPTIONS.wasmGlueUrl,
  wasmBinaryUrl: ASSET_OPTIONS.wasmBinaryUrl,
  maximumSnapshotBytes: 1024,
  maximumCommandBytes: 1024,
  maximumIntentBytes: 1024,
  maximumCommittedTransactionBytes: 1024,
  maximumQueryBytes: 68,
  maximumQueryResponseBytes: 1024,
  maximumPendingTransactions: 8,
} as const;

type FakeKernelMetrics = {
  opened: number;
  openCalls: number;
  forkCalls: number;
  stateHashCalls: number;
  disposed: number;
  disposeAttempts: number;
  disposeFailuresRemaining: number;
  snapshotCalls: number;
  liveSessions: Set<FakeSession>;
};

class FakeSession implements ArtifactWorkerKernelSession {
  readonly modality = "spreadsheet" as const;
  private disposed = false;
  private value: number;

  constructor(
    snapshot: Uint8Array,
    private readonly metrics: FakeKernelMetrics,
    kind: "open" | "fork" = "open",
  ) {
    this.value = snapshot[0]!;
    metrics.opened += 1;
    if (kind === "open") metrics.openCalls += 1;
    else metrics.forkCalls += 1;
    metrics.liveSessions.add(this);
  }

  applyCommitted(operationBytes: Uint8Array): void {
    this.requireOpen();
    const summary = decodeCommittedTransactionSummary(operationBytes);
    this.value = Number.parseInt(summary.transactionId.slice(-2), 16);
  }

  applyPending(intentBytes: Uint8Array): void {
    const intent = decodeEditableArtifactMutationIntent(intentBytes);
    this.apply(testCommandFirstValue(intent.commandBytes));
  }

  applyCommands(): Uint8Array {
    throw new Error("serialized commands are not supported by the fake spreadsheet session");
  }

  nativeRevision(): number {
    throw new Error("spreadsheet sessions do not have native revisions");
  }

  fork(): ArtifactWorkerKernelSession {
    this.requireOpen();
    return new FakeSession(new Uint8Array([this.value]), this.metrics, "fork");
  }

  stateHash(): Promise<string> {
    this.requireOpen();
    this.metrics.stateHashCalls += 1;
    return sha256Hex(new Uint8Array([this.value]));
  }

  snapshot(): Uint8Array {
    this.requireOpen();
    this.metrics.snapshotCalls += 1;
    return new Uint8Array([this.value]);
  }

  query(): Uint8Array {
    this.requireOpen();
    throw new Error("fake projection query is not configured");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.metrics.disposeAttempts += 1;
    this.metrics.disposed += 1;
    this.metrics.liveSessions.delete(this);
    if (this.metrics.disposeFailuresRemaining > 0) {
      this.metrics.disposeFailuresRemaining -= 1;
      throw new Error("injected cleanup failure");
    }
  }

  currentValue(): number {
    this.requireOpen();
    return this.value;
  }

  private apply(delta: number): void {
    this.requireOpen();
    if (delta === 0xff) throw new ArtifactWorkerPendingProjectionError("projection_conflict");
    if (delta === 0xfd) throw new Error("fatal fake kernel failure");
    this.value = (this.value + delta) & 0xff;
  }

  private requireOpen(): void {
    if (this.disposed) throw new Error("fake session closed");
  }
}

function createFakeAdapter(metrics = createMetrics()): ArtifactWorkerKernelAdapter {
  return {
    modality: "spreadsheet",
    protocolVersion: 1,
    kernelVersion: "kernel-test",
    modelSchemaVersion: 1,
    commandVersion: 1,
    maximumSnapshotBytes: 64 * 1024 * 1024,
    maximumCommandBytes: EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
    maximumIntentBytes: EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
    maximumCommittedTransactionBytes: 8 * 1024 * 1024,
    maximumQueryBytes: 68,
    maximumQueryResponseBytes: 8 * 1024 * 1024,
    canonicalizeSnapshot(bytes) {
      if (bytes.byteLength !== 1) throw new Error("invalid fake snapshot");
      return bytes.slice();
    },
    open(snapshotBytes) {
      return new FakeSession(snapshotBytes, metrics);
    },
  };
}

function createMetrics(): FakeKernelMetrics {
  return {
    opened: 0,
    openCalls: 0,
    forkCalls: 0,
    stateHashCalls: 0,
    disposed: 0,
    disposeAttempts: 0,
    disposeFailuresRemaining: 0,
    snapshotCalls: 0,
    liveSessions: new Set(),
  };
}

class InProcessArtifactWorker implements ArtifactWorkerClientEndpoint {
  private readonly mainMessageListeners = new Set<
    (event: ArtifactWorkerClientMessageEvent) => void
  >();
  private readonly mainErrorListeners = new Set<(event: ArtifactWorkerClientErrorEvent) => void>();
  private readonly mainMessageErrorListeners = new Set<
    (event: ArtifactWorkerClientErrorEvent) => void
  >();
  private readonly workerMessageListeners = new Set<(event: ArtifactWorkerMessageEvent) => void>();
  private readonly runtime: ArtifactWorkerRuntime;
  readonly transferredFromMain: ArrayBuffer[][] = [];
  terminated = false;
  responseDelayMs = 0;

  constructor(
    adapter: ArtifactWorkerKernelAdapter | ArtifactWorkerKernelAdapterFactory,
    onProtocolError?: () => void,
  ) {
    const endpoint: ArtifactWorkerRuntimeEndpoint = {
      addEventListener: (_type, listener) => this.workerMessageListeners.add(listener),
      removeEventListener: (_type, listener) => this.workerMessageListeners.delete(listener),
      postMessage: (message, transfer) => this.deliverToMain(message, transfer),
    };
    this.runtime = new ArtifactWorkerRuntime({
      endpoint,
      loadAdapter: typeof adapter === "function" ? adapter : async () => adapter,
      ...(onProtocolError ? { onProtocolError } : {}),
    });
  }

  addEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      | ((event: ArtifactWorkerClientMessageEvent) => void)
      | ((event: ArtifactWorkerClientErrorEvent) => void),
  ): void {
    if (type === "message") {
      this.mainMessageListeners.add(listener as (event: ArtifactWorkerClientMessageEvent) => void);
    } else if (type === "error") {
      this.mainErrorListeners.add(listener as (event: ArtifactWorkerClientErrorEvent) => void);
    } else {
      this.mainMessageErrorListeners.add(
        listener as (event: ArtifactWorkerClientErrorEvent) => void,
      );
    }
  }

  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      | ((event: ArtifactWorkerClientMessageEvent) => void)
      | ((event: ArtifactWorkerClientErrorEvent) => void),
  ): void {
    if (type === "message") {
      this.mainMessageListeners.delete(
        listener as (event: ArtifactWorkerClientMessageEvent) => void,
      );
    } else if (type === "error") {
      this.mainErrorListeners.delete(listener as (event: ArtifactWorkerClientErrorEvent) => void);
    } else {
      this.mainMessageErrorListeners.delete(
        listener as (event: ArtifactWorkerClientErrorEvent) => void,
      );
    }
  }

  postMessage(message: ArtifactWorkerRpcMessage, transfer: Transferable[]): void {
    if (this.terminated) throw new Error("worker terminated");
    this.transferredFromMain.push([message.frame, ...message.segments]);
    const cloned = structuredClone(message, { transfer });
    queueMicrotask(() => {
      if (this.terminated) return;
      for (const listener of this.workerMessageListeners) listener({ data: cloned });
    });
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    void this.runtime.dispose();
  }

  crash(message = "injected crash"): void {
    for (const listener of this.mainErrorListeners) {
      listener({ error: new Error(message), message });
    }
  }

  private deliverToMain(message: ArtifactWorkerRpcMessage, transfer: Transferable[]): void {
    const cloned = structuredClone(message, { transfer });
    const deliver = (): void => {
      // Deliberately deliver even after terminate; stale-listener fencing must
      // make a retired generation inert.
      for (const listener of this.mainMessageListeners) listener({ data: cloned });
    };
    if (this.responseDelayMs > 0) setTimeout(deliver, this.responseDelayMs);
    else queueMicrotask(deliver);
  }
}

describe("browser editable artifact Worker bridge", () => {
  test("preserves kernel revisions above Number.MAX_SAFE_INTEGER as bigint", () => {
    const revision = BigInt(Number.MAX_SAFE_INTEGER) + 17n;
    const bytes = encodeSpreadsheetMetadataKernelProjection({
      revision,
      modeledFeatures: { dimensions: false, hidden: false, merges: false },
      sheets: [],
    });
    const decoded = decodeSpreadsheetMetadataKernelProjection(bytes);
    expect(decoded.revision).toBe(revision);
    expect(typeof decoded.revision).toBe("bigint");
  });

  test("transfers private binary copies while retaining caller-owned bytes", async () => {
    const workers: InProcessArtifactWorker[] = [];
    const client = createClient(workers);
    const snapshot = await createSnapshot(4);
    const originalBuffer = snapshot.bytes.buffer;

    await expect(client.loadSnapshot(snapshot)).resolves.toEqual({
      stateHash: snapshot.stateHash,
      digest: snapshot.digest,
    });

    expect(originalBuffer.byteLength).toBe(1);
    expect(snapshot.bytes).toEqual(new Uint8Array([4]));
    const transferred = workers[0]!.transferredFromMain.flat();
    expect(transferred.some((buffer) => buffer.byteLength === 0)).toBe(true);
    await client.dispose();
  });

  test("keeps confirmed commits authoritative while reporting blocked speculative edits", async () => {
    const metrics = createMetrics();
    const workers: InProcessArtifactWorker[] = [];
    const client = createClient(workers, metrics);
    const snapshot = await createSnapshot(1);
    await client.loadSnapshot(snapshot);
    expect(metrics.liveSessions.size).toBe(2);
    expect(metrics.openCalls).toBe(1);
    expect(metrics.forkCalls).toBe(1);
    expect(metrics.snapshotCalls).toBe(0);

    const first = await client.authorPending({
      ...authorInput("pending-1", 2),
      observedHeadSequence: 7,
      selectiveUndoTargets: [UNDO_OPERATION_ID],
    });
    const intent = decodeEditableArtifactMutationIntent(first.intentBytes);
    expect(intent).toMatchObject({
      artifactId: ARTIFACT_ID,
      clientTransactionId: "pending-1",
      replicaId: REPLICA_ID,
      replicaCounter: 1,
      previousLocalTransactionId: null,
      observedHeadSequence: 7,
      causalBase: [],
      selectiveUndoOperationIds: [UNDO_OPERATION_ID],
      commandBytes: testCommand(2),
    });
    expect(hashEditableArtifactMutationIntentBytes(first.intentBytes)).toBe(first.requestHash);
    await expect(
      client.replacePending([{ ...first, commandBytes: testCommand(9) }]),
    ).rejects.toMatchObject({ code: "intent_mismatch" });
    const conflict = await client.authorPending({
      ...authorInput("pending-2", 0xff),
      previousLocalTransactionId: first.clientTransactionId,
      replicaCounter: 2,
    });
    const descendant = await client.authorPending({
      ...authorInput("pending-3", 1),
      previousLocalTransactionId: conflict.clientTransactionId,
      replicaCounter: 3,
    });
    const projected = await client.replacePending([first, conflict, descendant]);
    expect(projected.blockedPending).toEqual([
      { clientTransactionId: "pending-2", code: "projection_conflict" },
      { clientTransactionId: "pending-3", code: "blocked_predecessor" },
    ]);
    await expect(client.replacePending([first, conflict, descendant])).resolves.toEqual(projected);
    expect(metrics.liveSessions.size).toBe(2);
    expect(metrics.openCalls).toBe(1);
    expect(metrics.snapshotCalls).toBe(0);

    const transaction = await committed(snapshot, 3, 1, 1);
    const reconciled = await client.reconcileCommitted(transaction, [first, conflict, descendant]);
    expect(reconciled.stateHash).toBe(transaction.stateHash);
    expect(reconciled.blockedPending).toEqual(projected.blockedPending);
    expect(metrics.liveSessions.size).toBe(2);
    expect(metrics.openCalls).toBe(1);
    expect(metrics.snapshotCalls).toBe(0);
    expect(metrics.forkCalls).toBe(4);
    expect(metrics.stateHashCalls).toBe(2);

    const fatal = await client.authorPending({
      ...authorInput("pending-fatal", 0xfd),
      replicaCounter: 4,
    });
    await expect(client.replacePending([fatal])).rejects.toMatchObject({ code: "kernel_failed" });
    await expect(client.replacePending([first])).resolves.toEqual({ blockedPending: [] });
    expect(metrics.disposed).toBeGreaterThanOrEqual(3);
    await client.dispose();
  });

  test("keeps a newly installed state coherent when old-session cleanup throws", async () => {
    const workers: InProcessArtifactWorker[] = [];
    const metrics = createMetrics();
    const client = createBrowserEditableArtifactWorkerKernel({
      ...ASSET_OPTIONS,
      workerFactory() {
        const worker = new InProcessArtifactWorker(createFakeAdapter(metrics), () => {
          throw new Error("injected diagnostic failure");
        });
        workers.push(worker);
        return worker;
      },
    });
    await client.loadSnapshot(await createSnapshot(1));
    metrics.disposeFailuresRemaining = 2;

    const replacement = await createSnapshot(9);
    await expect(client.loadSnapshot(replacement)).resolves.toEqual({
      stateHash: replacement.stateHash,
      digest: replacement.digest,
    });
    expect(metrics.disposeAttempts).toBe(2);
    expect(metrics.liveSessions.size).toBe(2);

    const transaction = await committed(replacement, 2, 1, 1);
    await expect(client.reconcileCommitted(transaction, [])).resolves.toMatchObject({
      stateHash: transaction.stateHash,
    });
    expect(metrics.liveSessions.size).toBe(2);
    await client.dispose();
  });

  test("retires a crashed generation and reconstructs through a fresh Worker", async () => {
    const workers: InProcessArtifactWorker[] = [];
    const client = createClient(workers);
    await client.loadSnapshot(await createSnapshot(3));
    workers[0]!.crash();
    expect(workers[0]!.terminated).toBe(true);

    const next = await createSnapshot(8);
    await expect(client.loadSnapshot(next)).resolves.toEqual({
      stateHash: next.stateHash,
      digest: next.digest,
    });
    expect(workers).toHaveLength(2);
    await client.dispose();
  });

  test("retires a failed initialization so the next call starts a fresh generation", async () => {
    const workers: InProcessArtifactWorker[] = [];
    let factoryCalls = 0;
    const client = createBrowserEditableArtifactWorkerKernel({
      ...ASSET_OPTIONS,
      workerFactory() {
        factoryCalls += 1;
        const worker = new InProcessArtifactWorker(
          factoryCalls === 1
            ? async () => {
                throw new Error("injected initialization failure");
              }
            : createFakeAdapter(),
        );
        workers.push(worker);
        return worker;
      },
    });

    await expect(client.reset()).rejects.toMatchObject({ code: "kernel_failed" });
    expect(workers[0]!.terminated).toBe(true);
    await expect(client.reset()).resolves.toBeUndefined();
    expect(workers).toHaveLength(2);
    await client.dispose();
  });

  test("disposes an adapter cancelled while initialization is in flight", async () => {
    const listeners = new Set<(event: ArtifactWorkerMessageEvent) => void>();
    let releaseAdapter!: () => void;
    const adapterGate = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    let adapterDisposals = 0;
    const adapter: ArtifactWorkerKernelAdapter = {
      ...createFakeAdapter(),
      dispose() {
        adapterDisposals += 1;
      },
    };
    const runtime = new ArtifactWorkerRuntime({
      endpoint: {
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener),
        postMessage() {},
      },
      loadAdapter: async () => {
        await adapterGate;
        return adapter;
      },
    });
    const initialize = encodeArtifactWorkerRpcMessage({
      kind: ArtifactWorkerRpcKind.Initialize,
      generation: 1,
      requestId: 1,
      metadata: encodeInitialize({
        ...INITIALIZE_OPTIONS,
      }),
    });
    for (const listener of listeners) listener({ data: initialize });
    await Promise.resolve();
    const cancel = encodeArtifactWorkerRpcMessage({
      kind: ArtifactWorkerRpcKind.Cancel,
      generation: 1,
      requestId: 1,
    });
    for (const listener of listeners) listener({ data: cancel });
    releaseAdapter();
    await Bun.sleep(0);
    expect(adapterDisposals).toBe(1);
    await runtime.dispose();
  });

  test("rejects runtime queue overflow immediately instead of wedging the generation", async () => {
    const listeners = new Set<(event: ArtifactWorkerMessageEvent) => void>();
    const responses: ArtifactWorkerRpcMessage[] = [];
    let releaseAdapter!: () => void;
    const adapterGate = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    const runtime = new ArtifactWorkerRuntime({
      endpoint: {
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener),
        postMessage(message, transfer) {
          responses.push(structuredClone(message, { transfer }));
        },
      },
      loadAdapter: async () => {
        await adapterGate;
        return createFakeAdapter();
      },
    });
    const initialize = encodeArtifactWorkerRpcMessage({
      kind: ArtifactWorkerRpcKind.Initialize,
      generation: 1,
      requestId: 1,
      metadata: encodeInitialize({
        ...INITIALIZE_OPTIONS,
      }),
    });
    for (const listener of listeners) listener({ data: initialize });
    await Promise.resolve();
    for (let requestId = 2; requestId <= 65; requestId += 1) {
      const request = encodeArtifactWorkerRpcMessage({
        kind: ArtifactWorkerRpcKind.Reset,
        generation: 1,
        requestId,
      });
      for (const listener of listeners) listener({ data: request });
    }
    expect(responses).toHaveLength(1);
    expect(decodeArtifactWorkerRpcMessage(responses[0]!)).toMatchObject({
      kind: ArtifactWorkerRpcKind.Error,
      generation: 1,
      requestId: 65,
    });
    releaseAdapter();
    await runtime.dispose();
  });

  test("hard timeout terminates synchronous work and fences a delayed stale response", async () => {
    const workers: InProcessArtifactWorker[] = [];
    const client = createClient(workers, undefined, { requestTimeoutMs: 10 });
    await client.loadSnapshot(await createSnapshot(2));
    workers[0]!.responseDelayMs = 50;

    await expect(client.reset()).rejects.toMatchObject({ code: "worker_timeout" });
    expect(workers[0]!.terminated).toBe(true);
    await expect(client.loadSnapshot(await createSnapshot(9))).resolves.toMatchObject({
      stateHash: await sha256Hex(new Uint8Array([9])),
    });
    expect(workers).toHaveLength(2);
    await Bun.sleep(60);
    await client.dispose();
  });

  test("bounds concurrent requests and pending transfer bytes before copying", async () => {
    const workers: InProcessArtifactWorker[] = [];
    const client = createClient(workers, undefined, { maximumPendingAggregateBytes: 1 });
    await client.loadSnapshot(await createSnapshot(2));
    const pending = await client.authorPending(authorInput("bounded-pending", 1));
    await expect(client.replacePending([pending])).rejects.toMatchObject({
      code: "limit_exceeded",
    });

    workers[0]!.responseDelayMs = 20;
    const admitted = Array.from({ length: 64 }, () => client.reset());
    await expect(client.reset()).rejects.toMatchObject({ code: "client_busy" });
    await Promise.all(admitted);
    await client.dispose();
  });

  test("rejects malformed, oversized, and noncanonical frames before mutation", async () => {
    const valid = encodeArtifactWorkerRpcMessage({
      kind: ArtifactWorkerRpcKind.Reset,
      generation: 1,
      requestId: 1,
    });
    const corrupted = structuredClone(valid);
    const corruptBytes = new Uint8Array(corrupted.frame);
    corruptBytes[0] = corruptBytes[0]! ^ 1;
    expect(() => decodeArtifactWorkerRpcMessage(corrupted)).toThrow(ArtifactWorkerProtocolError);

    const trailing = new Uint8Array(valid.frame.byteLength + 1);
    trailing.set(new Uint8Array(valid.frame));
    expect(() => decodeArtifactWorkerRpcMessage({ frame: trailing.buffer, segments: [] })).toThrow(
      "truncated or trailing",
    );

    expect(() =>
      encodeArtifactWorkerRpcMessage({
        kind: ArtifactWorkerRpcKind.Reset,
        generation: 1,
        requestId: 1,
        metadata: new Uint8Array(8),
        limits: {
          maxMetadataBytes: 4,
          maxSegmentBytes: 4,
          maxTotalSegmentBytes: 4,
          maxSegments: 1,
        },
      }),
    ).toThrow("metadata exceeds");
    expect(() => new ArtifactWorkerBinaryWriter().string("\ud800")).toThrow(
      "unpaired UTF-16 surrogate",
    );

    const workers: InProcessArtifactWorker[] = [];
    const client = createClient(workers, undefined, { maximumCommandBytes: 1 });
    await client.loadSnapshot(await createSnapshot(1));
    await expect(
      client.authorPending({
        ...authorInput("too-large", 1),
        commandBytes: new Uint8Array([1, 2]),
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await client.dispose();
  });

  test("shares the canonical command and intent safety ceilings", async () => {
    const initialization = {
      ...INITIALIZE_OPTIONS,
      maximumCommandBytes: EDITABLE_ARTIFACT_COMMAND_MAX_BYTES,
    };
    expect(() => encodeInitialize(initialization)).not.toThrow();
    expect(() =>
      encodeInitialize({
        ...initialization,
        maximumCommandBytes: EDITABLE_ARTIFACT_COMMAND_MAX_BYTES + 1,
      }),
    ).toThrow("hard safety ceiling");

    const workers: InProcessArtifactWorker[] = [];
    const client = createClient(workers);
    await client.loadSnapshot(await createSnapshot(1));
    const pending = await client.authorPending(authorInput("intent-limit", 1));
    await expect(
      client.replacePending([
        {
          ...pending,
          intentBytes: new Uint8Array(EDITABLE_ARTIFACT_INTENT_MAX_BYTES + 1),
        },
      ]),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await client.dispose();
  });

  test("requires canonical commands and lazily creates no Worker during SSR construction", async () => {
    let factoryCalls = 0;
    const client = createBrowserEditableArtifactWorkerKernel({
      ...ASSET_OPTIONS,
      workerFactory() {
        factoryCalls += 1;
        throw new Error("no Worker in SSR");
      },
    });
    expect(factoryCalls).toBe(0);
    await expect(client.reset()).rejects.toThrow("no Worker in SSR");
    expect(factoryCalls).toBe(1);

    const workers: InProcessArtifactWorker[] = [];
    const live = createClient(workers);
    await live.loadSnapshot(await createSnapshot(1));
    await expect(
      live.authorPending({
        ...authorInput("noncanonical", 0xfe),
        commandBytes: new Uint8Array([0xfe]),
      }),
    ).rejects.toMatchObject({ code: "noncanonical_command" });
    await live.dispose();
  });

  test("fails closed on incompatible or noncanonical snapshots without installing partial state", async () => {
    const workers: InProcessArtifactWorker[] = [];
    const client = createClient(workers);
    const incompatible = await createSnapshot(1);
    incompatible.kernelVersion = "other-kernel";
    await expect(client.loadSnapshot(incompatible)).rejects.toMatchObject({
      code: "unsupported_protocol",
    });

    const good = await createSnapshot(2);
    await expect(client.loadSnapshot(good)).resolves.toMatchObject({ stateHash: good.stateHash });
    const badDigest = await createSnapshot(3);
    badDigest.digest = good.digest;
    await expect(client.loadSnapshot(badDigest)).rejects.toMatchObject({ code: "kernel_diverged" });

    const expectedStateHash = await sha256Hex(new Uint8Array([6]));
    const transaction = testCommitted({
      artifactId: ARTIFACT_ID,
      transactionId: "00000000000000010000000000000005",
      requestHash: await sha256Hex(new TextEncoder().encode("divergent-request")),
      startSequence: 1,
      endSequence: 1,
      priorStateHash: good.stateHash,
      stateHash: expectedStateHash,
      causalFrontier: [{ replicaId: REPLICA_ID, counter: 1 }],
    });
    await expect(client.reconcileCommitted(transaction, [])).rejects.toMatchObject({
      code: "kernel_diverged",
    });
    const valid = await committed(good, 4, 1, 1);
    await expect(client.reconcileCommitted(valid, [])).resolves.toMatchObject({
      stateHash: valid.stateHash,
    });
    await client.dispose();
  });

  test("rejects a package identity that does not match the executable Worker kernel", async () => {
    const workers: InProcessArtifactWorker[] = [];
    const client = createClient(workers, createMetrics(), {
      kernelVersion: "different-package-build",
    });
    await expect(client.reset()).rejects.toMatchObject({
      code: "runtime_identity_mismatch",
    });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(true);
    await client.dispose();
  });

  test("defaults to same-origin secure assets and allows explicit self-hosted origins", () => {
    expect(() =>
      createBrowserEditableArtifactWorkerKernel({
        ...ASSET_OPTIONS,
        applicationOrigin: "https://app.test",
      }),
    ).toThrow("asset origin is not allowed");

    expect(() =>
      createBrowserEditableArtifactWorkerKernel({
        ...ASSET_OPTIONS,
        wasmBinaryUrl: "https://cdn.test/kernel.wasm",
      }),
    ).toThrow("asset origin is not allowed");

    const client = createBrowserEditableArtifactWorkerKernel({
      ...ASSET_OPTIONS,
      wasmBinaryUrl: "https://cdn.test/kernel.wasm",
      allowedAssetOrigins: ["https://cdn.test"],
      workerFactory() {
        throw new Error("not invoked");
      },
    });
    expect(client).toBeDefined();
    expect(() =>
      createBrowserEditableArtifactWorkerKernel({
        ...ASSET_OPTIONS,
        workerUrl: "file:///tmp/worker.js",
        wasmGlueUrl: "file:///tmp/kernel.js",
        wasmBinaryUrl: "file:///tmp/kernel.wasm",
      }),
    ).toThrow("must use HTTPS");
  });

  test("initializes current wasm-bindgen web glue with module_or_path", async () => {
    const wasmBinaryUrl = "https://artifacts.test/kernel.wasm";
    const wasmGlueUrl = new URL("./worker-fixtures/wasm-glue.mjs", import.meta.url).href;
    const adapter = await loadBrowserWasmKernelAdapter({
      ...INITIALIZE_OPTIONS,
      wasmGlueUrl,
      wasmBinaryUrl,
    });
    expect(adapter).toMatchObject({
      protocolVersion: 1,
      kernelVersion: "worker-test-build",
      modelSchemaVersion: 1,
      commandVersion: 1,
    });
  });

  test("loads a truthful modality-specific WASM module without unrelated exports", async () => {
    const wasmGlueUrl = new URL("./worker-fixtures/wasm-document-glue.mjs", import.meta.url).href;
    const adapter = await loadBrowserWasmKernelAdapter({
      ...INITIALIZE_OPTIONS,
      modality: "document",
      maximumQueryBytes: 256,
      wasmGlueUrl,
    });
    expect(adapter).toMatchObject({
      modality: "document",
      protocolVersion: 1,
      kernelVersion: "worker-test-build",
      modelSchemaVersion: 1,
      commandVersion: 1,
    });
  });

  test("detaches every declared transfer exactly once", () => {
    const segment = ownedTransferBuffer(new Uint8Array([1, 2, 3]));
    const message = encodeArtifactWorkerRpcMessage({
      kind: ArtifactWorkerRpcKind.Reset,
      generation: 1,
      requestId: 1,
      segments: [segment],
    });
    const transfer = transferListForArtifactWorkerRpcMessage(message);
    const cloned = structuredClone(message, { transfer });
    expect(message.frame.byteLength).toBe(0);
    expect(message.segments[0]!.byteLength).toBe(0);
    expect(new Uint8Array(cloned.segments[0]!)).toEqual(new Uint8Array([1, 2, 3]));

    const alias = new ArrayBuffer(1);
    expect(() =>
      encodeArtifactWorkerRpcMessage({
        kind: ArtifactWorkerRpcKind.Reset,
        generation: 1,
        requestId: 2,
        segments: [alias, alias],
      }),
    ).toThrow("must not alias");

    const duplicateFrame = encodeArtifactWorkerRpcMessage({
      kind: ArtifactWorkerRpcKind.Reset,
      generation: 1,
      requestId: 3,
      segments: [new ArrayBuffer(1), new ArrayBuffer(1)],
    });
    const duplicate = new ArrayBuffer(1);
    expect(() =>
      decodeArtifactWorkerRpcMessage({
        frame: duplicateFrame.frame,
        segments: [duplicate, duplicate],
      }),
    ).toThrow("distinct buffers");

    const frameAlias = encodeArtifactWorkerRpcMessage({
      kind: ArtifactWorkerRpcKind.Reset,
      generation: 1,
      requestId: 4,
      segments: [new ArrayBuffer(40)],
    });
    expect(() =>
      decodeArtifactWorkerRpcMessage({
        frame: frameAlias.frame,
        segments: [frameAlias.frame],
      }),
    ).toThrow("distinct buffers");
  });
});

function createClient(
  workers: InProcessArtifactWorker[],
  metrics = createMetrics(),
  overrides: Partial<Parameters<typeof createBrowserEditableArtifactWorkerKernel>[0]> = {},
) {
  return createBrowserEditableArtifactWorkerKernel({
    ...ASSET_OPTIONS,
    workerFactory() {
      const worker = new InProcessArtifactWorker(createFakeAdapter(metrics));
      workers.push(worker);
      return worker;
    },
    ...overrides,
  });
}

async function createSnapshot(
  value: number,
  sequence = 0,
): Promise<EditableArtifactSpreadsheetSnapshot> {
  const bytes = new Uint8Array([value]);
  const hash = await sha256Hex(bytes);
  return {
    modality: "spreadsheet",
    artifactId: ARTIFACT_ID,
    sequence,
    stateHash: hash,
    causalFrontier: [],
    digest: hash,
    protocolVersion: 1,
    kernelVersion: "kernel-test",
    modelSchemaVersion: 1,
    bytes,
  };
}

function authorInput(transactionId: string, command: number) {
  return {
    modality: "spreadsheet",
    protocolVersion: 1,
    kernelVersion: "kernel-test",
    modelSchemaVersion: 1,
    commandVersion: 1,
    artifactId: ARTIFACT_ID,
    clientTransactionId: transactionId,
    replicaId: REPLICA_ID,
    replicaCounter: 1,
    previousLocalTransactionId: null,
    observedHeadSequence: 0,
    causalBase: [],
    selectiveUndoTargets: [],
    commandBytes: testCommand(command),
    createdAt: 1,
  } as const;
}

async function committed(
  previous: EditableArtifactSnapshot,
  delta: number,
  startSequence: number,
  endSequence: number,
): Promise<EditableArtifactCommittedTransaction> {
  const stateHash = await sha256Hex(new Uint8Array([(previous.bytes[0]! + delta) & 0xff]));
  const resultingValue = (previous.bytes[0]! + delta) & 0xff;
  return testCommitted({
    artifactId: ARTIFACT_ID,
    transactionId: `0000000000000001${resultingValue.toString(16).padStart(16, "0")}`,
    requestHash: await sha256Hex(new TextEncoder().encode(`request-${startSequence}`)),
    startSequence,
    endSequence,
    priorStateHash: previous.stateHash,
    stateHash,
    causalFrontier: [{ replicaId: REPLICA_ID, counter: endSequence }],
    protocolVersion: 1,
  });
}
