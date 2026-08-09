import { describe, expect, test } from "bun:test";
import packageJson from "../package.json" with { type: "json" };
import {
  decodeEditableArtifactMutationIntent,
  decodeSpreadsheetArtifactCommandBatch,
  encodeEditableArtifactMutationIntent,
  spreadsheetSheetId,
} from "@opengeni/contracts/editable-artifacts";
import {
  NativeDocumentSession,
  NativePresentationSession,
  NativeSpreadsheetSession,
  NativeTextLayoutSession,
  createNativeArtifactSession,
  openNativeArtifactSession,
} from "../src/native";
import {
  ArtifactKernelRuntime,
  type ArtifactKernelPackageManifest,
  type ArtifactRuntimeKind,
  type ArtifactRuntimeTarget,
} from "../src/runtime";

describe("native spreadsheet production facade", () => {
  test("authors exact OGATX/OGASC bytes through the native session", () => {
    const binding = fakeBinding();
    const runtime = fakeRuntime("native", "darwin-arm64", binding);
    const session = NativeSpreadsheetSession.create(runtime, 0x1234n);
    const resolvedBaseBytes = new Uint8Array([4, 5, 6]);

    const authored = session.authorCommands({
      intent: {
        artifactId: "11111111111111112222222222222222",
        clientTransactionId: "native.facade.1",
        replicaId: "0123456789abcdef",
        replicaCounter: 1,
        previousLocalTransactionId: null,
        observedHeadSequence: 0,
        causalBase: [],
        selectiveUndoOperationIds: [],
      },
      commands: {
        version: 1,
        commands: [
          {
            kind: "sheet.create",
            sheetId: spreadsheetSheetId("0123456789abcdef0000000000000001"),
            name: "Summary",
            after: null,
          },
          {
            kind: "cells.set",
            sheet: {
              kind: "created-in-batch",
              sheetId: spreadsheetSheetId("0123456789abcdef0000000000000001"),
              createCommandIndex: 0,
            },
            anchor: { row: 0, column: 0 },
            rows: 2,
            columns: 2,
            cells: ["Month", "Revenue", "Jan", 100],
          },
        ],
      },
      resolvedBaseBytes,
    });

    const intent = decodeEditableArtifactMutationIntent(authored.intentBytes);
    expect(intent.commandProtocolVersion).toBe(1);
    expect(decodeSpreadsheetArtifactCommandBatch(intent.commandBytes).commands).toHaveLength(2);
    expect(binding.lastSession?.lastIntent).toEqual(authored.intentBytes);
    expect(binding.lastSession?.lastResolvedBase).toEqual(resolvedBaseBytes);
    expect(authored.requestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(authored.committedTransactionBytes).toEqual(new Uint8Array([0x4f, 0x47, 0x41]));
    expect(session.kind).toBe("native");
    expect(session.modality).toBe("spreadsheet");
    expect(session.target).toBe("darwin-arm64");
  });

  test("forwards only byte envelopes and preserves lifecycle/fork isolation", () => {
    const binding = fakeBinding();
    const runtime = fakeRuntime("native", "linux-x64-gnu", binding);
    const session = NativeSpreadsheetSession.open(runtime, new Uint8Array([8]));
    expect(session.query(new Uint8Array([3]))).toEqual(new Uint8Array([3, 9]));
    expect(session.snapshot()).toEqual(new Uint8Array([1, 2, 3]));
    expect(session.frontier()).toEqual(new Uint8Array([7, 8]));
    expect(session.stateHash()).toBe(`sha256:${"a".repeat(64)}`);
    expect(session.revision()).toBe(4n);

    const branch = session.fork();
    branch.applyCommitted(new Uint8Array([6]));
    expect(binding.lastFork?.lastCommitted).toEqual(new Uint8Array([6]));
    expect(binding.lastSession?.lastCommitted).toBeUndefined();
    branch.dispose();
    expect(branch.isClosed()).toBe(true);
    expect(session.isClosed()).toBe(false);
    session.dispose();
    session.dispose();
    expect(session.isClosed()).toBe(true);
  });

  test("never falls back to WASM or the TypeScript reference model", () => {
    const wasm = fakeRuntime("wasm", "wasm-web", fakeBinding());
    expect(() => NativeSpreadsheetSession.create(wasm, 1n)).toThrow(
      "NativeSpreadsheetSession requires an exact local N-API kernel",
    );
  });

  test("routes document, presentation, and text-layout sessions through exact native bindings", () => {
    const runtime = fakeRuntime("native", "darwin-arm64", fakeBinding());
    const document = NativeDocumentSession.create(runtime, 1n);
    expect(document.applyCommands(new Uint8Array([1]))).toEqual(new Uint8Array([1, 4]));
    expect(document.query(new Uint8Array([2]))).toEqual(new Uint8Array([2, 9]));
    expect(document.fork().modality).toBe("document");
    const presentation = NativePresentationSession.open(runtime, new Uint8Array([1]));
    expect(presentation.applyCommands(new Uint8Array([3]))).toEqual(new Uint8Array([3, 4]));
    expect(presentation.fork().modality).toBe("presentation");
    const text = NativeTextLayoutSession.open(runtime, new Uint8Array([5]));
    expect(text.layout(new Uint8Array([6]))).toEqual(new Uint8Array([6, 7]));
    expect(
      createNativeArtifactSession(runtime, { modality: "document", replicaNamespace: 2n }).modality,
    ).toBe("document");
    expect(
      openNativeArtifactSession(runtime, {
        modality: "presentation",
        snapshot: new Uint8Array([1]),
      }).modality,
    ).toBe("presentation");
    document.dispose();
    presentation.dispose();
    text.dispose();
  });

  test("rejects legacy duplicate-authority command bytes before native apply", () => {
    const runtime = fakeRuntime("native", "darwin-arm64", fakeBinding());
    const session = NativeSpreadsheetSession.create(runtime, 1n);
    const intentBytes = encodeEditableArtifactMutationIntent({
      envelopeVersion: 1,
      protocolVersion: 1,
      modelSchemaVersion: 1,
      commandProtocolVersion: 1,
      artifactId: "11111111111111112222222222222222",
      clientTransactionId: "legacy.ogar",
      replicaId: "0123456789abcdef",
      replicaCounter: 1,
      previousLocalTransactionId: null,
      observedHeadSequence: 0,
      causalBase: [],
      selectiveUndoOperationIds: [],
      commandBytes: new TextEncoder().encode("OGAR"),
    });
    expect(() => session.authorTransaction(intentBytes, new Uint8Array([1]))).toThrow(
      "spreadsheet command",
    );
  });

  test("capability negotiation rejects a missing OGASC version", () => {
    const binding = fakeBinding();
    const capabilities = JSON.parse(new TextDecoder().decode(binding.capabilities())) as Record<
      string,
      unknown
    >;
    delete capabilities.spreadsheetCommandVersion;
    binding.capabilities = () => new TextEncoder().encode(JSON.stringify(capabilities));
    expect(() => fakeRuntime("native", "darwin-arm64", binding)).toThrow(
      "spreadsheetCommandVersion",
    );
  });
});

type FakeSession = ReturnType<typeof createFakeSession>;

function createFakeSession(): {
  lastIntent?: Uint8Array;
  lastResolvedBase?: Uint8Array;
  lastCommitted?: Uint8Array;
  closed: boolean;
  authorTransaction(intent: Uint8Array, resolvedBase: Uint8Array): Uint8Array;
  applyCommands(commands: Uint8Array): Uint8Array;
  applyCommitted(operation: Uint8Array): void;
  query(request: Uint8Array): Uint8Array;
  snapshot(): Uint8Array;
  frontier(): Uint8Array;
  stateHash(): string;
  revision(): bigint;
  fork(): FakeSession;
  dispose(): void;
} {
  return {
    closed: false,
    authorTransaction(intent, resolvedBase) {
      this.lastIntent = intent.slice();
      this.lastResolvedBase = resolvedBase.slice();
      return new Uint8Array([0x4f, 0x47, 0x41]);
    },
    applyCommands(commands) {
      return new Uint8Array([...commands, 4]);
    },
    applyCommitted(operation) {
      this.lastCommitted = operation.slice();
    },
    query(request) {
      return new Uint8Array([...request, 9]);
    },
    snapshot: () => new Uint8Array([1, 2, 3]),
    frontier: () => new Uint8Array([7, 8]),
    stateHash: () => `sha256:${"a".repeat(64)}`,
    revision: () => 4n,
    fork() {
      return createFakeSession();
    },
    dispose() {
      this.closed = true;
    },
  };
}

type FakeBinding = {
  lastSession?: FakeSession;
  lastFork?: FakeSession;
  capabilities(): Uint8Array;
  buildIdentity(): Uint8Array;
  canonicalizeCollaborationSnapshot(snapshot: Uint8Array): Uint8Array;
  createDocument(namespace: Uint8Array): Uint8Array;
  applyDocumentCommands(snapshot: Uint8Array, commands: Uint8Array): Uint8Array;
  queryDocument(snapshot: Uint8Array, query: Uint8Array): Uint8Array;
  canonicalizeDocumentSnapshot(snapshot: Uint8Array): Uint8Array;
  createPresentation(namespace: Uint8Array): Uint8Array;
  applyPresentationCommands(snapshot: Uint8Array, commands: Uint8Array): Uint8Array;
  queryPresentation(snapshot: Uint8Array, query: Uint8Array): Uint8Array;
  canonicalizePresentationSnapshot(snapshot: Uint8Array): Uint8Array;
  layoutText(fontBundle: Uint8Array, request: Uint8Array): Uint8Array;
  canonicalizeRenderTile(value: Uint8Array): Uint8Array;
  canonicalizeRenderPatch(value: Uint8Array): Uint8Array;
  ArtifactCollaborationSession: {
    create(namespace: Uint8Array): FakeSession;
    open(snapshot: Uint8Array): FakeSession;
  };
  ArtifactDocumentSession: {
    create(namespace: Uint8Array): FakeSession;
    open(snapshot: Uint8Array): FakeSession;
  };
  ArtifactPresentationSession: {
    create(namespace: Uint8Array): FakeSession;
    open(snapshot: Uint8Array): FakeSession;
  };
  ArtifactTextLayoutSession: {
    open(fontBundle: Uint8Array): {
      closed: boolean;
      layout(request: Uint8Array): Uint8Array;
      dispose(): void;
    };
  };
};

function fakeBinding(): FakeBinding {
  const binding: FakeBinding = {
    capabilities: () =>
      new TextEncoder().encode(
        JSON.stringify({
          abiVersion: 1,
          buildIdentityFormat: "utf8",
          commandSchemaVersion: 1,
          spreadsheetCommandVersion: 1,
          kernelSnapshotVersion: 1,
          receiptSchemaVersion: 1,
          collaborationSnapshotVersion: 1,
          editableArtifactIntentVersion: 1,
          committedTransactionVersion: 1,
          queryVersion: 1,
          queryResponseVersion: 1,
          collaboration: true,
          document: true,
          documentCommandVersion: 1,
          documentQueryResponseVersion: 1,
          documentQueryVersion: 1,
          documentReceiptVersion: 1,
          documentSnapshotVersion: 1,
          documentStatefulSessions: true,
          presentation: true,
          presentationCommandVersion: 1,
          presentationQueryResponseVersion: 1,
          presentationQueryVersion: 1,
          presentationSnapshotVersion: 1,
          presentationStatefulSessions: true,
          textLayout: true,
          textLayoutFontBundleVersion: 1,
          textLayoutRequestVersion: 1,
          textLayoutResponseVersion: 1,
          textLayoutStatefulSessions: true,
          retainedRenderPatchVersion: 1,
          retainedRenderTileVersion: 1,
          workbookMetadataQueries: true,
          canonicalStateHash: "sha256:canonical-snapshot",
          maxCellsPerBatch: 1_000,
          maxCommandBytes: 1_000,
          maxCommands: 100,
          maxCommittedTransactionBytes: 1_000,
          maxDocumentCommandBytes: 1_000,
          maxDocumentCommands: 100,
          maxDocumentQueryBytes: 1_000,
          maxDocumentQueryResponseBytes: 1_000,
          maxDocumentSnapshotBytes: 1_000,
          maxIntentBytes: 1_000,
          maxMetadataScannedCells: 1_000,
          maxMetadataSheets: 100,
          maxPresentationCommandBytes: 1_000,
          maxPresentationQueryBytes: 1_000,
          maxPresentationResponseBytes: 1_000,
          maxPresentationSnapshotBytes: 1_000,
          maxQueryBytes: 1_000,
          maxQueryResponseBytes: 1_000,
          maxSnapshotBytes: 1_000,
          maxSpreadsheetCommandBytes: 1_000,
          maxTextLayoutFontBundleBytes: 1_000,
          maxTextLayoutRequestBytes: 1_000,
          maxTextLayoutResponseBytes: 1_000,
          maxViewportArea: 1_000,
          maxViewportCells: 1_000,
          safeRust: true,
          sessionForks: true,
          statefulSessions: true,
          transport: "bounded-uint8array",
        }),
      ),
    buildIdentity: () => new TextEncoder().encode("test-build"),
    canonicalizeCollaborationSnapshot: (snapshot: Uint8Array) => snapshot.slice(),
    createDocument: (namespace: Uint8Array) => namespace.slice(),
    applyDocumentCommands: (_snapshot: Uint8Array, commands: Uint8Array) => commands.slice(),
    queryDocument: (_snapshot: Uint8Array, query: Uint8Array) => query.slice(),
    canonicalizeDocumentSnapshot: (snapshot: Uint8Array) => snapshot.slice(),
    createPresentation: (namespace: Uint8Array) => namespace.slice(),
    applyPresentationCommands: (_snapshot: Uint8Array, commands: Uint8Array) => commands.slice(),
    queryPresentation: (_snapshot: Uint8Array, query: Uint8Array) => query.slice(),
    canonicalizePresentationSnapshot: (snapshot: Uint8Array) => snapshot.slice(),
    layoutText: (_fontBundle: Uint8Array, request: Uint8Array) => request.slice(),
    canonicalizeRenderTile: (value: Uint8Array) => value.slice(),
    canonicalizeRenderPatch: (value: Uint8Array) => value.slice(),
    ArtifactCollaborationSession: {
      create: (_namespace: Uint8Array) => {
        const session = createFakeSession();
        const originalFork = session.fork;
        session.fork = () => {
          const fork = originalFork.call(session);
          binding.lastFork = fork;
          return fork;
        };
        binding.lastSession = session;
        return session;
      },
      open: (_snapshot: Uint8Array) => {
        const session = createFakeSession();
        const originalFork = session.fork;
        session.fork = () => {
          const fork = originalFork.call(session);
          binding.lastFork = fork;
          return fork;
        };
        binding.lastSession = session;
        return session;
      },
    },
    ArtifactDocumentSession: {
      create: () => createFakeSession(),
      open: () => createFakeSession(),
    },
    ArtifactPresentationSession: {
      create: () => createFakeSession(),
      open: () => createFakeSession(),
    },
    ArtifactTextLayoutSession: {
      open: () => ({
        closed: false,
        layout(request: Uint8Array) {
          return new Uint8Array([...request, 7]);
        },
        dispose() {
          this.closed = true;
        },
      }),
    },
  };
  return binding;
}

function fakeRuntime(
  kind: ArtifactRuntimeKind,
  target: ArtifactRuntimeTarget,
  binding: ReturnType<typeof fakeBinding>,
): ArtifactKernelRuntime {
  return new ArtifactKernelRuntime(kind, binding, {
    schemaVersion: 1,
    target,
    kind,
    packageName: `@opengeni/artifact-kernel-${target}`,
    packageVersion: packageJson.version,
    artifactToolVersion: packageJson.version,
    buildIdentity: "test-build",
    entrypoint: {
      path: "index.js",
      bytes: 1,
      sha256: `sha256:${"1".repeat(64)}`,
    },
    asset: {
      path: kind === "native" ? "kernel.node" : "kernel.wasm",
      bytes: 1,
      sha256: `sha256:${"0".repeat(64)}`,
    },
    supportFiles: [],
  } satisfies ArtifactKernelPackageManifest);
}
