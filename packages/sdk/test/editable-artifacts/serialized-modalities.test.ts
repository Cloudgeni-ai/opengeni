import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  artifactKernelRuntimeIdentity as documentIdentity,
  editableArtifactKernelAssets as documentAssets,
} from "@opengeni/artifact-kernel-wasm-document";
import {
  artifactKernelRuntimeIdentity as presentationIdentity,
  editableArtifactKernelAssets as presentationAssets,
} from "@opengeni/artifact-kernel-wasm-presentation";
import {
  artifactKernelRuntimeIdentity as spreadsheetIdentity,
  editableArtifactKernelAssets as spreadsheetAssets,
} from "@opengeni/artifact-kernel-wasm-spreadsheet";
import {
  EDITABLE_ARTIFACT_INTENT_VERSION,
  hashEditableArtifactMutationIntent,
} from "@opengeni/contracts/editable-artifacts";
import {
  DOCUMENT_ARTIFACT_COMMAND_VERSION,
  encodeDocumentArtifactCommandBatch,
  type DocumentArtifactCommandBatch,
} from "@opengeni/contracts/document-artifact-commands";
import { encodeEditableArtifactSerializedCommit } from "@opengeni/contracts/editable-artifact-serialized-commit";
import {
  PRESENTATION_ARTIFACT_COMMAND_VERSION,
  encodePresentationArtifactCommandBatch,
  type PresentationArtifactCommandBatch,
} from "@opengeni/contracts/presentation-artifact-commands";
import {
  editableArtifactCacheNamespace,
  type EditableArtifactCacheAuthority,
} from "../../src/editable-artifacts/controller";
import { createEditableArtifactSession } from "../../src/editable-artifacts/session";
import { MemoryEditableArtifactStorage } from "../../src/editable-artifacts/storage";
import type {
  EditableArtifactBootstrap,
  EditableArtifactCommittedTransaction,
  EditableArtifactLiveClose,
  EditableArtifactLiveConnection,
  EditableArtifactLiveMessage,
  EditableArtifactPendingTransaction,
  EditableArtifactReplayPage,
  EditableArtifactModality,
  EditableArtifactSerializedCommittedTransaction,
  EditableArtifactSerializedModality,
  EditableArtifactSerializedSnapshot,
  EditableArtifactSubmitReceipt,
  EditableArtifactSyncTicket,
  EditableArtifactSyncTransport,
} from "../../src/editable-artifacts/types";
import {
  createBrowserEditableArtifactWorkerKernel,
  type ArtifactWorkerClientEndpoint,
  type ArtifactWorkerClientErrorEvent,
  type ArtifactWorkerClientMessageEvent,
} from "../../src/editable-artifacts/worker/browser-client";
import {
  loadBrowserWasmKernelAdapter,
  type ArtifactWorkerKernelAdapter,
} from "../../src/editable-artifacts/worker/kernel-adapter";
import type { ArtifactWorkerRpcMessage } from "../../src/editable-artifacts/worker/rpc-protocol";
import {
  ArtifactWorkerRuntime,
  type ArtifactWorkerMessageEvent,
  type ArtifactWorkerRuntimeEndpoint,
} from "../../src/editable-artifacts/worker/runtime";
import { sha256Hex } from "../../src/editable-artifacts/worker/wire-codec";

const ARTIFACT_ID = "10000000000000000000000000000001";
const WRITER_REPLICA_ID = "0000000000000001";
const REMOTE_REPLICA_ID = "0000000000000002";
const REMOTE_TRANSACTION_ID = "20000000000000000000000000000001";
const WASM_PROFILES = Object.freeze({
  spreadsheet: wasmProfile(spreadsheetAssets, spreadsheetIdentity),
  document: wasmProfile(documentAssets, documentIdentity),
  presentation: wasmProfile(presentationAssets, presentationIdentity),
}) satisfies Record<EditableArtifactModality, ReturnType<typeof wasmProfile>>;

function wasmProfile<
  Identity extends {
    kernelVersion: string;
    protocolVersion: number;
    modelSchemaVersion: number;
    commandVersion: number;
  },
>(assets: { wasmGlueUrl: URL; wasmBinaryUrl: URL }, identity: Identity) {
  return Object.freeze({
    identity,
    glueUrl: assets.wasmGlueUrl.href,
    binaryUrl: `data:application/wasm;base64,${Buffer.from(
      readFileSync(fileURLToPath(assets.wasmBinaryUrl)),
    ).toString("base64")}`,
  });
}
const STORAGE_AUTHORITY: EditableArtifactCacheAuthority = {
  deploymentOrigin: "https://artifacts.test",
  accountId: "account-1",
  workspaceId: "workspace-1",
  principalId: "principal-1",
  authorizationEpoch: "authorization-1",
};

type SerializedScenario = Readonly<{
  modality: EditableArtifactSerializedModality;
  localBatch: DocumentArtifactCommandBatch | PresentationArtifactCommandBatch;
  remoteBatch: DocumentArtifactCommandBatch | PresentationArtifactCommandBatch;
}>;

const SCENARIOS: readonly SerializedScenario[] = [
  {
    modality: "document",
    localBatch: {
      version: DOCUMENT_ARTIFACT_COMMAND_VERSION,
      commands: [{ kind: "document.flags.set", trackRevisions: true }],
    },
    remoteBatch: {
      version: DOCUMENT_ARTIFACT_COMMAND_VERSION,
      commands: [{ kind: "document.flags.set", evenAndOddHeaders: true }],
    },
  },
  {
    modality: "presentation",
    localBatch: {
      version: PRESENTATION_ARTIFACT_COMMAND_VERSION,
      commands: [
        { kind: "presentation.size.set", size: { width: 12_000_000, height: 7_000_000 } },
        {
          kind: "slide.create",
          id: "0123456789abcdef0000000000000002",
          index: 0,
          title: "SDK editor",
          layoutId: null,
          background: { kind: "none" },
        },
        {
          kind: "node.insert",
          owner: { kind: "slide", id: "0123456789abcdef0000000000000002" },
          parentId: null,
          index: 0,
          node: {
            id: "0123456789abcdef0000000000000003",
            name: "Title",
            bounds: { x: 0, y: 0, width: 1_000_000, height: 500_000 },
            transform: { rotation: 0, flipHorizontal: false, flipVertical: false },
            content: {
              kind: "shape",
              geometry: "text-box",
              fill: { kind: "none" },
              line: { fill: { kind: "none" }, width: 0, dash: "solid" },
              text: null,
              placeholder: { kind: "title", index: 0 },
            },
          },
        },
      ],
    },
    remoteBatch: {
      version: PRESENTATION_ARTIFACT_COMMAND_VERSION,
      commands: [{ kind: "presentation.size.set", size: { width: 10_000_000, height: 6_000_000 } }],
    },
  },
];

describe("serialized document/presentation SDK integration", () => {
  test("loads the isolated real spreadsheet collaboration kernel", async () => {
    const profile = WASM_PROFILES.spreadsheet;
    const adapter = await loadBrowserWasmKernelAdapter({
      modality: "spreadsheet",
      kernelVersion: profile.identity.kernelVersion,
      protocolVersion: profile.identity.protocolVersion,
      modelSchemaVersion: profile.identity.modelSchemaVersion,
      commandVersion: profile.identity.commandVersion,
      wasmGlueUrl: profile.glueUrl,
      wasmBinaryUrl: profile.binaryUrl,
      maximumSnapshotBytes: 64 * 1024 * 1024,
      maximumCommandBytes: 4 * 1024 * 1024,
      maximumIntentBytes: 5 * 1024 * 1024,
      maximumCommittedTransactionBytes: 8 * 1024 * 1024,
      maximumQueryBytes: 68,
      maximumQueryResponseBytes: 8 * 1024 * 1024,
      maximumPendingTransactions: 8,
    });
    const wasm = (await import(profile.glueUrl)) as {
      ArtifactCollaborationSession: {
        create(namespace: Uint8Array): { snapshot(): Uint8Array; free(): void };
      };
      ArtifactDocumentSession?: unknown;
      ArtifactPresentationSession?: unknown;
    };
    expect(wasm.ArtifactDocumentSession).toBeUndefined();
    expect(wasm.ArtifactPresentationSession).toBeUndefined();
    const created = wasm.ArtifactCollaborationSession.create(encodeNamespace(0x0123n));
    try {
      const session = adapter.open(created.snapshot());
      try {
        expect(session.modality).toBe("spreadsheet");
        expect(await session.stateHash()).toMatch(/^sha256:[0-9a-f]{64}$/u);
      } finally {
        session.dispose();
      }
    } finally {
      created.free();
    }
  });

  test("allocates durable document and presentation structure through public helpers", async () => {
    for (const modality of ["document", "presentation"] as const) {
      const adapter = await loadRealAdapter(modality);
      const snapshot = await createInitialSnapshot(modality, adapter);
      const session = createSession(
        modality,
        adapter,
        new MemoryEditableArtifactStorage(),
        new SerializedTransport(
          bootstrap(
            modality,
            adapter,
            snapshot,
            snapshot.sequence,
            snapshot.stateHash,
            snapshot.nativeRevision,
          ),
          [],
        ),
      );
      await session.whenReady();

      if (modality === "document") {
        const created = await session.createDocumentParagraph({
          runs: [{ text: "First paragraph", style: { bold: true } }],
          clientTransactionId: "create.document.paragraph.1",
        });
        expect(created.paragraphId).toMatch(/^p\/0123456789abcdef[0-9a-f]{16}$/u);
        const body = await session.queryDocument({
          kind: "body",
          startBlock: 0,
          limits: { maxItems: 8, maxTextUtf16: 1_024, maxTableCells: 1 },
        });
        expect(body.items).toMatchObject([
          { kind: "paragraph", id: created.paragraphId, runs: [{ text: "First paragraph" }] },
        ]);
      } else {
        const created = await session.createPresentationSlide({
          index: 0,
          title: "Opening",
          clientTransactionId: "create.presentation.slide.1",
        });
        expect(created.slideId).toMatch(/^(?!0+$)[0-9a-f]{32}$/u);
        const catalog = await session.queryPresentationSlideCatalog({
          kind: "slide-catalog",
          startSlide: 0,
          maxSlides: 8,
          maxTextBytes: 1_024,
          maxBytes: 8_192,
        });
        expect(catalog.slides).toMatchObject([{ id: created.slideId, title: "Opening" }]);
      }
      await session.close();
    }
  });

  test("settles an own serialized commit broadcast before its delayed submit receipt", async () => {
    const adapter = await loadRealAdapter("document");
    const snapshot = await createInitialSnapshot("document", adapter);
    const authority = adapter.open(snapshot.bytes);
    const history: EditableArtifactCommittedTransaction[] = [];
    let sequence = 0;
    let stateHash = snapshot.stateHash;
    let releaseFirstReceipt!: () => void;
    const firstReceiptGate = new Promise<void>((resolve) => {
      releaseFirstReceipt = resolve;
    });
    let transport!: SerializedTransport;
    transport = new SerializedTransport(
      { ...bootstrap("document", adapter, snapshot, 0, snapshot.stateHash, 0), writable: true },
      history,
      async (pending) => {
        const nextSequence = sequence + 1;
        const priorStateHash = stateHash;
        const priorNativeRevision = authority.nativeRevision();
        const nativeReceiptBytes = authority.applyCommands(pending.commandBytes);
        const nativeRevision = authority.nativeRevision();
        stateHash = await authority.stateHash();
        sequence = nextSequence;
        const transaction: EditableArtifactSerializedCommittedTransaction = {
          artifactId: ARTIFACT_ID,
          modality: "document",
          transactionId: `${"4".repeat(31)}${nextSequence}`,
          requestHash: pending.requestHash,
          startSequence: nextSequence,
          endSequence: nextSequence,
          priorStateHash,
          stateHash,
          priorNativeRevision,
          nativeRevision,
          commitProtocolVersion: 1,
          committedTransactionBytes: encodeEditableArtifactSerializedCommit({
            modality: "document",
            transactionId: `${"4".repeat(31)}${nextSequence}`,
            parentHeadSequence: nextSequence - 1,
            resultHeadSequence: nextSequence,
            priorNativeRevision,
            priorStateHash,
            stateHash,
            intentBytes: pending.intentBytes,
            nativeReceiptBytes,
          }),
        };
        history.push(transaction);
        transport.connection.push({ type: "transaction.committed", transaction });
        if (nextSequence === 1) await firstReceiptGate;
        return {
          artifactId: ARTIFACT_ID,
          clientTransactionId: pending.clientTransactionId,
          transactionId: transaction.transactionId,
          requestHash: pending.requestHash,
          committed: transaction,
        };
      },
    );
    const session = createSession(
      "document",
      adapter,
      new MemoryEditableArtifactStorage(),
      transport,
    );
    try {
      await session.whenReady();
      await session.applyDocumentCommands(
        {
          version: DOCUMENT_ARTIFACT_COMMAND_VERSION,
          commands: [{ kind: "document.flags.set", trackRevisions: true }],
        },
        { clientTransactionId: "serialized.race.document.1" },
      );
      await eventually(() => {
        const view = session.getView();
        return view.cursor === 1 && view.pendingTransactions === 0;
      });

      await session.applyDocumentCommands(
        {
          version: DOCUMENT_ARTIFACT_COMMAND_VERSION,
          commands: [{ kind: "document.flags.set", evenAndOddHeaders: true }],
        },
        { clientTransactionId: "serialized.race.document.2" },
      );
      releaseFirstReceipt();
      await eventually(() => {
        const view = session.getView();
        return (
          view.cursor === 2 && view.pendingTransactions === 0 && view.blockedPending.length === 0
        );
      });
      const document = await session.queryDocument({ kind: "summary" });
      expect(document.items.find((item) => item.kind === "summary")).toMatchObject({
        kind: "summary",
        trackRevisions: true,
        evenAndOddHeaders: true,
      });
    } finally {
      releaseFirstReceipt();
      await session.close();
      authority.dispose();
    }
  });

  for (const scenario of SCENARIOS) {
    test(`uses real ${scenario.modality} WASM and fails closed when a remote winner makes local WAL stale`, async () => {
      const adapter = await loadRealAdapter(scenario.modality);
      const snapshot = await createInitialSnapshot(scenario.modality, adapter);
      const remote = await createRemoteCommit(scenario, adapter, snapshot);
      const storage = new MemoryEditableArtifactStorage();
      const firstTransport = new SerializedTransport(
        bootstrap(
          scenario.modality,
          adapter,
          snapshot,
          snapshot.sequence,
          snapshot.stateHash,
          snapshot.nativeRevision,
        ),
        [],
      );
      const first = createSession(scenario.modality, adapter, storage, firstTransport);

      await first.whenReady();
      if (scenario.modality === "document") {
        await first.applyDocumentCommands(scenario.localBatch as DocumentArtifactCommandBatch, {
          clientTransactionId: "local.document.1",
        });
        const local = await first.queryDocument({ kind: "summary" });
        const summary = local.items.find((item) => item.kind === "summary");
        expect(summary?.kind === "summary" && summary.trackRevisions).toBe(true);
      } else {
        await first.applyPresentationCommands(
          scenario.localBatch as PresentationArtifactCommandBatch,
          { clientTransactionId: "local.presentation.1" },
        );
        const local = await first.queryPresentation({ kind: "metadata", maxBytes: 4_096 });
        expect(local.kind === "metadata" && local.slideSize.width).toBe(12_000_000);
        const catalog = await first.queryPresentationSlideCatalog({
          kind: "slide-catalog",
          startSlide: 0,
          maxSlides: 8,
          maxTextBytes: 4_096,
          maxBytes: 16_384,
        });
        expect(catalog.slides).toMatchObject([
          { id: "0123456789abcdef0000000000000002", title: "SDK editor" },
        ]);
        const editor = await first.queryPresentationEditorSlide({
          kind: "editor-slide",
          slideId: "0123456789abcdef0000000000000002",
          maxNodes: 16,
          maxTextBytes: 4_096,
          maxBytes: 16_384,
        });
        expect(editor.nodes).toMatchObject([
          {
            id: "0123456789abcdef0000000000000003",
            order: 0,
            content: { kind: "shape", placeholder: { kind: "title", index: 0 } },
          },
        ]);
      }

      firstTransport.connection.push({ type: "transaction.committed", transaction: remote });
      await eventually(() => {
        const view = first.getView();
        return (
          view.cursor === 1 &&
          view.blockedPending.some((pending) => pending.code === "serialized_head_conflict")
        );
      });

      if (scenario.modality === "document") {
        const confirmed = await first.queryDocument({ kind: "summary" });
        const summary = confirmed.items.find((item) => item.kind === "summary");
        expect(summary).toMatchObject({
          kind: "summary",
          evenAndOddHeaders: true,
          trackRevisions: false,
        });
        await expect(
          first.applyDocumentCommands(scenario.localBatch as DocumentArtifactCommandBatch, {
            clientTransactionId: "local.document.2",
          }),
        ).rejects.toMatchObject({ code: "pending_conflict" });
      } else {
        const confirmed = await first.queryPresentation({ kind: "metadata", maxBytes: 4_096 });
        expect(confirmed).toMatchObject({
          kind: "metadata",
          slideSize: { width: 10_000_000, height: 6_000_000 },
        });
        await expect(
          first.applyPresentationCommands(scenario.localBatch as PresentationArtifactCommandBatch, {
            clientTransactionId: "local.presentation.2",
          }),
        ).rejects.toMatchObject({ code: "pending_conflict" });
      }

      const scope = {
        namespace: editableArtifactCacheNamespace(STORAGE_AUTHORITY),
        artifactId: ARTIFACT_ID,
        modality: scenario.modality,
      } as const;
      expect(await storage.listPending(scope)).toHaveLength(1);
      await first.close();

      const secondTransport = new SerializedTransport(
        bootstrap(scenario.modality, adapter, null, 1, remote.stateHash, remote.nativeRevision),
        [remote],
      );
      const second = createSession(scenario.modality, adapter, storage, secondTransport);
      await second.whenReady();

      expect(secondTransport.openResume).toEqual({
        modality: scenario.modality,
        nativeRevision: remote.nativeRevision,
      });
      expect(secondTransport.bootstrapResume).toMatchObject({
        localCursor: 1,
        localStateHash: remote.stateHash,
        resume: { modality: scenario.modality, localNativeRevision: remote.nativeRevision },
      });
      expect(second.getView()).toMatchObject({
        modality: scenario.modality,
        cursor: 1,
        pendingTransactions: 1,
      });
      expect(second.getView().blockedPending).toContainEqual({
        clientTransactionId: `local.${scenario.modality}.1`,
        code: "serialized_head_conflict",
      });
      await second.close();
    });
  }
});

function createSession(
  modality: EditableArtifactSerializedModality,
  adapter: ArtifactWorkerKernelAdapter,
  storage: MemoryEditableArtifactStorage,
  transport: EditableArtifactSyncTransport,
) {
  const worker = createBrowserEditableArtifactWorkerKernel({
    modality,
    kernelVersion: adapter.kernelVersion,
    protocolVersion: adapter.protocolVersion,
    modelSchemaVersion: adapter.modelSchemaVersion,
    commandVersion: adapter.commandVersion,
    applicationOrigin: "https://artifacts.test",
    workerUrl: "https://artifacts.test/editable-artifacts-worker.js",
    wasmGlueUrl: "https://artifacts.test/artifact_kernel.js",
    wasmBinaryUrl: "https://artifacts.test/artifact_kernel_bg.wasm",
    workerFactory: () => new InProcessArtifactWorker(adapter),
  });
  return createEditableArtifactSession({
    artifactId: ARTIFACT_ID,
    modality,
    storageAuthority: STORAGE_AUTHORITY,
    transport,
    storage,
    worker,
    kernelVersion: adapter.kernelVersion,
    modelSchemaVersion: adapter.modelSchemaVersion,
    commandVersion: adapter.commandVersion,
    protocolVersion: adapter.protocolVersion,
    writerReplicaIdFactory: () => WRITER_REPLICA_ID,
  });
}

async function loadRealAdapter(
  modality: EditableArtifactSerializedModality,
): Promise<ArtifactWorkerKernelAdapter> {
  const profile = WASM_PROFILES[modality];
  return await loadBrowserWasmKernelAdapter({
    modality,
    kernelVersion: profile.identity.kernelVersion,
    protocolVersion: profile.identity.protocolVersion,
    modelSchemaVersion: profile.identity.modelSchemaVersion,
    commandVersion: profile.identity.commandVersion,
    wasmGlueUrl: profile.glueUrl,
    wasmBinaryUrl: profile.binaryUrl,
    maximumSnapshotBytes: 64 * 1024 * 1024,
    maximumCommandBytes: 4 * 1024 * 1024,
    maximumIntentBytes: 5 * 1024 * 1024,
    maximumCommittedTransactionBytes: 8 * 1024 * 1024,
    maximumQueryBytes: modality === "document" ? 256 : 96,
    maximumQueryResponseBytes: 8 * 1024 * 1024,
    maximumPendingTransactions: 8,
  });
}

async function createInitialSnapshot(
  modality: EditableArtifactSerializedModality,
  adapter: ArtifactWorkerKernelAdapter,
): Promise<EditableArtifactSerializedSnapshot> {
  const wasm = (await import(WASM_PROFILES[modality].glueUrl)) as {
    createDocument: (namespace: Uint8Array) => Uint8Array;
    createPresentation: (namespace: Uint8Array) => Uint8Array;
  };
  const namespace = encodeNamespace(0x0123_4567_89ab_cdefn);
  const bytes =
    modality === "document" ? wasm.createDocument(namespace) : wasm.createPresentation(namespace);
  const session = adapter.open(bytes);
  try {
    return {
      artifactId: ARTIFACT_ID,
      modality,
      sequence: 0,
      stateHash: await session.stateHash(),
      digest: await sha256Hex(bytes),
      kernelVersion: adapter.kernelVersion,
      modelSchemaVersion: adapter.modelSchemaVersion,
      nativeRevision: session.nativeRevision(),
      bytes,
    };
  } finally {
    session.dispose();
  }
}

async function createRemoteCommit(
  scenario: SerializedScenario,
  adapter: ArtifactWorkerKernelAdapter,
  snapshot: EditableArtifactSerializedSnapshot,
): Promise<EditableArtifactSerializedCommittedTransaction> {
  const commandBytes =
    scenario.modality === "document"
      ? encodeDocumentArtifactCommandBatch(scenario.remoteBatch as DocumentArtifactCommandBatch)
      : encodePresentationArtifactCommandBatch(
          scenario.remoteBatch as PresentationArtifactCommandBatch,
        );
  const authored = hashEditableArtifactMutationIntent({
    envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
    protocolVersion: adapter.protocolVersion,
    modelSchemaVersion: adapter.modelSchemaVersion,
    commandProtocolVersion: adapter.commandVersion,
    artifactId: ARTIFACT_ID,
    clientTransactionId: `remote.${scenario.modality}.1`,
    replicaId: REMOTE_REPLICA_ID,
    replicaCounter: 1,
    previousLocalTransactionId: null,
    observedHeadSequence: 0,
    causalBase: [],
    selectiveUndoOperationIds: [],
    commandBytes,
  });
  const authority = adapter.open(snapshot.bytes);
  try {
    const priorNativeRevision = authority.nativeRevision();
    const nativeReceiptBytes = authority.applyCommands(commandBytes);
    const nativeRevision = authority.nativeRevision();
    const stateHash = await authority.stateHash();
    const committedTransactionBytes = encodeEditableArtifactSerializedCommit({
      modality: scenario.modality,
      transactionId: REMOTE_TRANSACTION_ID,
      parentHeadSequence: 0,
      resultHeadSequence: 1,
      priorNativeRevision,
      priorStateHash: snapshot.stateHash,
      stateHash,
      intentBytes: authored.bytes,
      nativeReceiptBytes,
    });
    return {
      artifactId: ARTIFACT_ID,
      modality: scenario.modality,
      transactionId: REMOTE_TRANSACTION_ID,
      requestHash: authored.requestHash,
      startSequence: 1,
      endSequence: 1,
      priorStateHash: snapshot.stateHash,
      stateHash,
      priorNativeRevision,
      nativeRevision,
      commitProtocolVersion: 1,
      committedTransactionBytes,
    };
  } finally {
    authority.dispose();
  }
}

function bootstrap(
  modality: EditableArtifactSerializedModality,
  adapter: ArtifactWorkerKernelAdapter,
  snapshot: EditableArtifactSerializedSnapshot | null,
  headSequence: number,
  headStateHash: string,
  headNativeRevision: number,
): EditableArtifactBootstrap {
  return {
    artifactId: ARTIFACT_ID,
    modality,
    protocolVersion: adapter.protocolVersion,
    headSequence,
    headStateHash,
    headNativeRevision,
    kernelVersion: adapter.kernelVersion,
    modelSchemaVersion: adapter.modelSchemaVersion,
    writable: false,
    minimumReplaySequence: 1,
    snapshot,
    resyncRequired: false,
  };
}

class SerializedTransport implements EditableArtifactSyncTransport {
  readonly connection: SerializedConnection;
  openResume: Parameters<EditableArtifactSyncTransport["openLive"]>[0]["resume"] | null = null;
  bootstrapResume: Parameters<EditableArtifactLiveConnection["readBootstrap"]>[0] | null = null;

  constructor(
    private readonly configuredBootstrap: EditableArtifactBootstrap,
    readonly history: readonly EditableArtifactCommittedTransaction[],
    readonly onSubmit?: (
      transaction: EditableArtifactPendingTransaction,
    ) => Promise<EditableArtifactSubmitReceipt>,
  ) {
    this.connection = new SerializedConnection(this);
  }

  async mintTicket(
    input: Parameters<EditableArtifactSyncTransport["mintTicket"]>[0],
  ): Promise<EditableArtifactSyncTicket> {
    return {
      artifactId: input.artifactId,
      modality: this.configuredBootstrap.modality,
      replicaId: input.replicaId,
      token: "one-use-test-ticket",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      protocolVersion: this.configuredBootstrap.protocolVersion,
    };
  }

  async openLive(
    input: Parameters<EditableArtifactSyncTransport["openLive"]>[0],
  ): Promise<EditableArtifactLiveConnection> {
    this.openResume = input.resume;
    this.connection.onMessage = input.onMessage;
    return this.connection;
  }

  bootstrap(): EditableArtifactBootstrap {
    return this.configuredBootstrap;
  }
}

class SerializedConnection implements EditableArtifactLiveConnection {
  readonly streamEpoch = "serialized-test-epoch";
  readonly limits = {
    maxClientFrameBytes: 9 * 1024 * 1024,
    maxCommandBytes: 4 * 1024 * 1024,
    maxIntentBytes: 5 * 1024 * 1024,
    maxCommittedTransactionBytes: 8 * 1024 * 1024,
    maxSnapshotBytes: 64 * 1024 * 1024,
    maxInFlightTransactions: 8,
    maxInFlightBytes: 16 * 1024 * 1024,
  };
  readonly closed: Promise<EditableArtifactLiveClose>;
  onMessage: (message: EditableArtifactLiveMessage) => void = () => undefined;
  private resolveClosed!: (value: EditableArtifactLiveClose) => void;

  constructor(private readonly transport: SerializedTransport) {
    this.closed = new Promise((resolveClose) => {
      this.resolveClosed = resolveClose;
    });
  }

  async readBootstrap(
    input: Parameters<EditableArtifactLiveConnection["readBootstrap"]>[0],
  ): Promise<EditableArtifactBootstrap> {
    this.transport.bootstrapResume = input;
    return this.transport.bootstrap();
  }

  async replay(
    input: Parameters<EditableArtifactLiveConnection["replay"]>[0],
  ): Promise<EditableArtifactReplayPage> {
    return {
      artifactId: ARTIFACT_ID,
      transactions: this.transport.history.filter(
        (transaction) =>
          transaction.endSequence > input.after && transaction.endSequence <= input.through,
      ),
      headSequence: this.transport.history.at(-1)?.endSequence ?? 0,
    };
  }

  async submit(input: {
    transaction: EditableArtifactPendingTransaction;
  }): Promise<EditableArtifactSubmitReceipt> {
    if (!this.transport.onSubmit) {
      throw new Error("read-only serialized integration transport must not submit");
    }
    return await this.transport.onSubmit(input.transaction);
  }

  async acknowledge(): Promise<void> {}

  close(): void {
    this.resolveClosed({ reason: "closed" });
  }

  push(message: EditableArtifactLiveMessage): void {
    this.onMessage(message);
  }
}

class InProcessArtifactWorker implements ArtifactWorkerClientEndpoint {
  private readonly mainMessageListeners = new Set<
    (event: ArtifactWorkerClientMessageEvent) => void
  >();
  private readonly mainErrorListeners = new Set<(event: ArtifactWorkerClientErrorEvent) => void>();
  private readonly workerMessageListeners = new Set<(event: ArtifactWorkerMessageEvent) => void>();
  private readonly runtime: ArtifactWorkerRuntime;
  private terminated = false;

  constructor(adapter: ArtifactWorkerKernelAdapter) {
    const endpoint: ArtifactWorkerRuntimeEndpoint = {
      addEventListener: (_type, listener) => this.workerMessageListeners.add(listener),
      removeEventListener: (_type, listener) => this.workerMessageListeners.delete(listener),
      postMessage: (message, transfer) => this.deliverToMain(message, transfer),
    };
    this.runtime = new ArtifactWorkerRuntime({ endpoint, loadAdapter: async () => adapter });
  }

  addEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      | ((event: ArtifactWorkerClientMessageEvent) => void)
      | ((event: ArtifactWorkerClientErrorEvent) => void),
  ): void {
    if (type === "message") {
      this.mainMessageListeners.add(listener as (event: ArtifactWorkerClientMessageEvent) => void);
    } else {
      this.mainErrorListeners.add(listener as (event: ArtifactWorkerClientErrorEvent) => void);
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
    } else {
      this.mainErrorListeners.delete(listener as (event: ArtifactWorkerClientErrorEvent) => void);
    }
  }

  postMessage(message: ArtifactWorkerRpcMessage, transfer: Transferable[]): void {
    if (this.terminated) throw new Error("worker terminated");
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

  private deliverToMain(message: ArtifactWorkerRpcMessage, transfer: Transferable[]): void {
    const cloned = structuredClone(message, { transfer });
    queueMicrotask(() => {
      for (const listener of this.mainMessageListeners) listener({ data: cloned });
    });
  }
}

function encodeNamespace(namespace: bigint): Uint8Array {
  const envelope = new Uint8Array(28);
  envelope.set(new TextEncoder().encode("OGAKN001"));
  const view = new DataView(envelope.buffer);
  view.setUint16(8, 1, true);
  view.setBigUint64(12, namespace, true);
  view.setBigUint64(20, fnv1a64(envelope.subarray(0, 20)), true);
  return envelope;
}

function fnv1a64(bytes: Uint8Array): bigint {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x0100_0000_01b3n);
  }
  return hash;
}

async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not settle before timeout");
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 1));
  }
}
