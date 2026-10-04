import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import {
  artifactKernelRuntimeIdentity,
  editableArtifactKernelAssets,
} from "@opengeni/artifact-kernel-wasm-presentation";
import { PRESENTATION_ARTIFACT_COMMAND_VERSION } from "@opengeni/contracts/presentation-artifact-commands";
import { encodeEditableArtifactSerializedCommit } from "@opengeni/contracts/editable-artifact-serialized-commit";
import {
  createEditableArtifactSession,
  editableArtifactCacheNamespace,
  MemoryEditableArtifactStorage,
  type EditableArtifactBootstrap,
  type EditableArtifactCacheAuthority,
  type EditableArtifactLiveConnection,
  type EditableArtifactLiveClose,
  type EditableArtifactPendingTransaction,
  type EditableArtifactSerializedCommittedTransaction,
  type EditableArtifactSerializedSnapshot,
  type EditableArtifactSubmitReceipt,
  type EditableArtifactSyncTransport,
} from "@opengeni/sdk/editable-artifacts";
import { createBrowserEditableArtifactWorkerKernel } from "../../sdk/src/editable-artifacts/worker/browser-client";
import {
  loadBrowserWasmKernelAdapter,
  type ArtifactWorkerKernelAdapter,
} from "../../sdk/src/editable-artifacts/worker/kernel-adapter";
import { sha256Hex } from "../../sdk/src/editable-artifacts/worker/wire-codec";
import { InProcessArtifactWorker } from "../../sdk/test/editable-artifacts/in-process-artifact-worker";
import { EditablePresentationArtifactSurface } from "../src/components/artifacts/editable-presentation";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const ARTIFACT_ID = "10000000000000000000000000000001";
const FIRST_REPLICA = "0000000000000001";
const REOPENED_REPLICA = "0000000000000002";
const STORAGE_AUTHORITY: EditableArtifactCacheAuthority = {
  deploymentOrigin: "https://artifacts.test",
  accountId: "test-account",
  workspaceId: "test-workspace",
  principalId: "test-principal",
  authorizationEpoch: "test-authorization",
};

test("reopened presentation waits for its original writer receipt before authoring", async () => {
  const adapter = await realPresentationAdapter();
  const snapshot = await initialSnapshot(adapter);
  const storage = new MemoryEditableArtifactStorage();
  const first = session(adapter, storage, transport(snapshot, false), FIRST_REPLICA);
  await first.whenReady();
  await first.applyPresentationCommands({
    version: PRESENTATION_ARTIFACT_COMMAND_VERSION,
    commands: [0, 1].map((index) => ({
      kind: "slide.create" as const,
      id: index === 0 ? "20000000000000000000000000000001" : "20000000000000000000000000000002",
      index,
      title: index === 0 ? "Opening" : "Next",
      layoutId: null,
      background: { kind: "none" as const },
    })),
  });
  await first.close();
  const scope = {
    namespace: editableArtifactCacheNamespace(STORAGE_AUTHORITY),
    artifactId: ARTIFACT_ID,
    modality: "presentation" as const,
  };
  const [retained] = await storage.listPending(scope);
  expect(retained?.replicaId).toBe(FIRST_REPLICA);
  let releaseReceipt!: () => void;
  const receiptGate = new Promise<void>((resolve) => {
    releaseReceipt = resolve;
  });
  const authority = adapter.open(snapshot.bytes);
  const submitted: EditableArtifactPendingTransaction[] = [];
  const ticketReplicas: string[] = [];
  let sequence = 0;
  let stateHash = snapshot.stateHash;
  const reopened = session(
    adapter,
    storage,
    transport(
      snapshot,
      true,
      async (pending) => {
        submitted.push(pending);
        if (submitted.length === 1) await receiptGate;
        const priorNativeRevision = authority.nativeRevision();
        const priorStateHash = stateHash;
        const nativeReceiptBytes = authority.applyCommands(pending.commandBytes);
        stateHash = await authority.stateHash();
        const nativeRevision = authority.nativeRevision();
        const transactionId = `${"3".repeat(31)}${++sequence}`;
        const committed: EditableArtifactSerializedCommittedTransaction = {
          artifactId: ARTIFACT_ID,
          modality: "presentation",
          transactionId,
          requestHash: pending.requestHash,
          startSequence: sequence,
          endSequence: sequence,
          priorStateHash,
          stateHash,
          priorNativeRevision,
          nativeRevision,
          commitProtocolVersion: 1,
          committedTransactionBytes: encodeEditableArtifactSerializedCommit({
            modality: "presentation",
            transactionId,
            parentHeadSequence: sequence - 1,
            resultHeadSequence: sequence,
            priorNativeRevision,
            priorStateHash,
            stateHash,
            intentBytes: pending.intentBytes,
            nativeReceiptBytes,
          }),
        };
        return {
          artifactId: ARTIFACT_ID,
          clientTransactionId: pending.clientTransactionId,
          transactionId,
          requestHash: pending.requestHash,
          committed,
        };
      },
      ticketReplicas,
    ),
    REOPENED_REPLICA,
  );
  const commandErrors: Error[] = [];
  let rendered: Awaited<ReturnType<typeof renderComponent>> | undefined;
  try {
    await reopened.whenReady();
    await eventually(() => submitted.length === 1);
    expect(ticketReplicas).toEqual([FIRST_REPLICA]);
    expect(submitted[0]?.clientTransactionId).toBe(retained?.clientTransactionId);
    expect(submitted[0]?.requestHash).toBe(retained?.requestHash);
    // The controller already rejects a first new command while the original
    // writer owns pending intent; the editor must expose that same barrier.
    await expect(reopened.createPresentationSlide({ index: 2 })).rejects.toThrow(
      "pending edits from a prior writer must settle",
    );
    rendered = await renderComponent(
      <EditablePresentationArtifactSurface
        session={reopened}
        onCommandError={(error) => commandErrors.push(error)}
      />,
    );
    await flush(30);
    const add = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add text box"]',
    )!;
    expect(add).toBeTruthy();
    expect(add.disabled).toBe(true);
    const editor = rendered.container.querySelector<HTMLElement>("[data-og-presentation-editor]")!;
    expect(editor.getAttribute("aria-busy")).toBe("true");
    expect(editor.getAttribute("data-og-command-state")).toBe("pending");
    expect(rendered.container.textContent).toContain("Saving earlier changes…");
    await actRun(() =>
      rendered!.container
        .querySelector<HTMLButtonElement>('button[aria-label="Next slide"]')!
        .click(),
    );
    expect(
      rendered.container.querySelector('[role="application"]')?.getAttribute("aria-label"),
    ).toBe("Slide 2 editor");
    await actRun(() => add.click());
    expect(submitted).toHaveLength(1);
    expect(await storage.listPending(scope)).toHaveLength(1);
    await actRun(async () => {
      releaseReceipt();
      await eventually(() => reopened.getView().pendingTransactions === 0);
    });
    await flush(30);
    expect(reopened.getView().authoringBlockedReason).toBeUndefined();
    expect(await storage.listPending(scope)).toEqual([]);
    expect(add.disabled).toBe(false);
    await actRun(() => add.click());
    await actRun(async () => {
      await eventually(
        () => submitted.length === 2 && reopened.getView().pendingTransactions === 0,
      );
    });
    expect(submitted[1]?.replicaId).toBe(REOPENED_REPLICA);
    const slide = await reopened.queryPresentationEditorSlide({
      kind: "editor-slide",
      slideId: "20000000000000000000000000000002",
      maxNodes: 16,
      maxTextBytes: 4096,
      maxBytes: 65536,
    });
    expect(slide.nodes).toHaveLength(1);
    expect(commandErrors).toEqual([]);
  } finally {
    releaseReceipt();
    await rendered?.unmount();
    await reopened.close();
    authority.dispose();
  }
});

function session(
  adapter: ArtifactWorkerKernelAdapter,
  storage: MemoryEditableArtifactStorage,
  syncTransport: EditableArtifactSyncTransport,
  replica: string,
) {
  return createEditableArtifactSession({
    artifactId: ARTIFACT_ID,
    storageAuthority: STORAGE_AUTHORITY,
    transport: syncTransport,
    storage,
    ...artifactKernelRuntimeIdentity,
    writerReplicaIdFactory: () => replica,
    worker: createBrowserEditableArtifactWorkerKernel({
      ...artifactKernelRuntimeIdentity,
      applicationOrigin: "https://artifacts.test",
      workerUrl: "https://artifacts.test/worker.js",
      wasmGlueUrl: "https://artifacts.test/kernel.js",
      wasmBinaryUrl: "https://artifacts.test/kernel.wasm",
      workerFactory: () => new InProcessArtifactWorker(adapter),
    }),
  });
}

function transport(
  snapshot: EditableArtifactSerializedSnapshot,
  writable: boolean,
  submit?: (pending: EditableArtifactPendingTransaction) => Promise<EditableArtifactSubmitReceipt>,
  replicas: string[] = [],
): EditableArtifactSyncTransport {
  let bootstrap: Extract<EditableArtifactBootstrap, { modality: "document" | "presentation" }> = {
    artifactId: ARTIFACT_ID,
    modality: "presentation",
    liveProtocolVersion: 2,
    headSequence: 0,
    headStateHash: snapshot.stateHash,
    headNativeRevision: snapshot.nativeRevision,
    kernelVersion: snapshot.kernelVersion,
    modelSchemaVersion: snapshot.modelSchemaVersion,
    writable,
    minimumReplaySequence: 1,
    snapshot,
    resyncRequired: false,
  };
  const history: EditableArtifactSerializedCommittedTransaction[] = [];
  function connection(): EditableArtifactLiveConnection {
    let close!: (value: EditableArtifactLiveClose) => void;
    return {
      streamEpoch: "presentation-test-epoch",
      limits: {
        maxClientFrameBytes: 9 * 1024 * 1024,
        maxCommandBytes: 4 * 1024 * 1024,
        maxIntentBytes: 5 * 1024 * 1024,
        maxCommittedTransactionBytes: 8 * 1024 * 1024,
        maxSnapshotBytes: 64 * 1024 * 1024,
        maxInFlightTransactions: 8,
        maxInFlightBytes: 16 * 1024 * 1024,
      },
      closed: new Promise((resolve) => {
        close = resolve;
      }),
      readBootstrap: async () => bootstrap,
      replay: async ({ after, through }) => ({
        artifactId: ARTIFACT_ID,
        transactions: history.filter(
          (transaction) => transaction.endSequence > after && transaction.endSequence <= through,
        ),
        headSequence: bootstrap.headSequence,
      }),
      submit: async ({ transaction }) => {
        if (!submit) throw new Error("unexpected test submission");
        const receipt = await submit(transaction);
        const committed = receipt.committed as EditableArtifactSerializedCommittedTransaction;
        history.push(committed);
        bootstrap = {
          ...bootstrap,
          headSequence: committed.endSequence,
          headStateHash: committed.stateHash,
          headNativeRevision: committed.nativeRevision,
        };
        return receipt;
      },
      acknowledge: async () => {},
      close: () => close({ reason: "closed" }),
    };
  }
  return {
    mintTicket: async ({ artifactId, replicaId }) => {
      replicas.push(replicaId);
      return {
        artifactId,
        modality: "presentation",
        replicaId,
        token: "test-ticket",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        protocolVersion: 2,
      };
    },
    openLive: async () => connection(),
  };
}

async function realPresentationAdapter(): Promise<ArtifactWorkerKernelAdapter> {
  // Initialize from the checked-in bytes: the DOM harness's Response is not
  // Bun's native Response accepted by WebAssembly.instantiateStreaming.
  const wasm = (await import(editableArtifactKernelAssets.wasmGlueUrl.href)) as {
    default: (input: { module_or_path: Uint8Array }) => Promise<unknown>;
  };
  await wasm.default({
    module_or_path: readFileSync(fileURLToPath(editableArtifactKernelAssets.wasmBinaryUrl)),
  });
  return loadBrowserWasmKernelAdapter({
    ...artifactKernelRuntimeIdentity,
    wasmGlueUrl: editableArtifactKernelAssets.wasmGlueUrl.href,
    wasmBinaryUrl: `data:application/wasm;base64,${Buffer.from(readFileSync(fileURLToPath(editableArtifactKernelAssets.wasmBinaryUrl))).toString("base64")}`,
    maximumSnapshotBytes: 64 * 1024 * 1024,
    maximumCommandBytes: 4 * 1024 * 1024,
    maximumIntentBytes: 5 * 1024 * 1024,
    maximumCommittedTransactionBytes: 8 * 1024 * 1024,
    maximumQueryBytes: 96,
    maximumQueryResponseBytes: 8 * 1024 * 1024,
    maximumPendingTransactions: 8,
  });
}

async function initialSnapshot(
  adapter: ArtifactWorkerKernelAdapter,
): Promise<EditableArtifactSerializedSnapshot> {
  const wasm = (await import(editableArtifactKernelAssets.wasmGlueUrl.href)) as {
    createPresentation: (namespace: Uint8Array) => Uint8Array;
  };
  const namespace = new Uint8Array(28);
  namespace.set(new TextEncoder().encode("OGAKN001"));
  const view = new DataView(namespace.buffer);
  view.setUint16(8, 1, true);
  view.setBigUint64(12, 0x0123_4567_89ab_cdefn, true);
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of namespace.subarray(0, 20))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x0100_0000_01b3n);
  view.setBigUint64(20, hash, true);
  const bytes = wasm.createPresentation(namespace);
  const opened = adapter.open(bytes);
  try {
    return {
      artifactId: ARTIFACT_ID,
      modality: "presentation",
      sequence: 0,
      stateHash: await opened.stateHash(),
      digest: await sha256Hex(bytes),
      kernelVersion: adapter.kernelVersion,
      modelSchemaVersion: adapter.modelSchemaVersion,
      nativeRevision: opened.nativeRevision(),
      bytes,
    };
  } finally {
    opened.dispose();
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
