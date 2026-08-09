import {
  EDITABLE_ARTIFACT_INTENT_VERSION,
  SPREADSHEET_ARTIFACT_COMMAND_VERSION,
  assertCanonicalSpreadsheetArtifactCommandBytes,
  decodeEditableArtifactMutationIntent,
  encodeEditableArtifactMutationIntent,
  encodeSpreadsheetArtifactCommandBatch,
  hashEditableArtifactMutationIntentBytes,
  type EditableArtifactMutationIntent,
  type SpreadsheetArtifactCommandBatch,
} from "@opengeni/contracts/editable-artifacts";
import {
  ArtifactCollaborationSession,
  ArtifactDocumentSession,
  ArtifactKernelRuntime,
  ArtifactPresentationSession,
  ArtifactRuntimeError,
  ArtifactTextLayoutSession,
  type ArtifactKernelCapabilities,
  type NativeArtifactRuntimeTarget,
} from "./runtime";

export {
  SPREADSHEET_ARTIFACT_COMMAND_VERSION,
  assertCanonicalSpreadsheetArtifactCommandBytes,
  decodeSpreadsheetArtifactCommandBatch,
  editableArtifactStableId,
  encodeSpreadsheetArtifactCommandBatch,
  spreadsheetSheetId,
} from "@opengeni/contracts/editable-artifacts";
export type {
  EditableArtifactStableId,
  SpreadsheetArtifactCommand,
  SpreadsheetArtifactCommandBatch,
  SpreadsheetCellInput,
  SpreadsheetCellPoint,
  SpreadsheetCellRange,
  SpreadsheetSheetGeneration,
  SpreadsheetSheetPrecondition,
} from "@opengeni/contracts/editable-artifacts";

export type NativeArtifactModality = "spreadsheet" | "document" | "presentation";

export type NativeSpreadsheetIntentFields = Omit<
  EditableArtifactMutationIntent,
  | "envelopeVersion"
  | "protocolVersion"
  | "modelSchemaVersion"
  | "commandProtocolVersion"
  | "commandBytes"
>;

export type NativeSpreadsheetAuthorCommandsInput = Readonly<{
  intent: NativeSpreadsheetIntentFields;
  commands: SpreadsheetArtifactCommandBatch;
  /** Exact authoritative OGACF001 base selected for this apply attempt. */
  resolvedBaseBytes: Uint8Array;
}>;

export type NativeSpreadsheetAuthoredTransaction = Readonly<{
  /** Exact canonical OGATX001 bytes passed to Rust. */
  intentBytes: Uint8Array;
  requestHash: string;
  /** One whole canonical OGACO001 transaction returned by Rust. */
  committedTransactionBytes: Uint8Array;
}>;

export type CreateNativeArtifactSessionInput = Readonly<{
  modality: NativeArtifactModality;
  replicaNamespace: bigint;
}>;

export type OpenNativeArtifactSessionInput = Readonly<{
  modality: NativeArtifactModality;
  snapshot: Uint8Array;
}>;

export type NativeArtifactSession =
  | NativeSpreadsheetSession
  | NativeDocumentSession
  | NativePresentationSession;

/**
 * Synchronous Node/Bun production spreadsheet session backed only by the
 * verified Rust N-API collaboration kernel. It never selects the TypeScript
 * reference model and deliberately rejects a browser/WASM runtime; browsers
 * use the asynchronous `@opengeni/sdk/editable-artifacts` Worker API.
 */
export class NativeSpreadsheetSession {
  readonly kind = "native" as const;
  readonly modality = "spreadsheet" as const;
  readonly target: NativeArtifactRuntimeTarget;
  readonly capabilities: ArtifactKernelCapabilities;
  readonly buildIdentity: string;

  private constructor(
    private readonly runtime: ArtifactKernelRuntime,
    private readonly session: ArtifactCollaborationSession,
  ) {
    requireNativeSpreadsheetRuntime(runtime);
    this.target = runtime.target as NativeArtifactRuntimeTarget;
    this.capabilities = runtime.capabilities;
    this.buildIdentity = runtime.buildIdentity;
  }

  static create(
    runtime: ArtifactKernelRuntime,
    replicaNamespace: bigint,
  ): NativeSpreadsheetSession {
    requireNativeSpreadsheetRuntime(runtime);
    return new NativeSpreadsheetSession(
      runtime,
      runtime.createCollaborationSession(replicaNamespace),
    );
  }

  static open(runtime: ArtifactKernelRuntime, snapshot: Uint8Array): NativeSpreadsheetSession {
    requireNativeSpreadsheetRuntime(runtime);
    return new NativeSpreadsheetSession(runtime, runtime.openCollaborationSession(snapshot));
  }

  /**
   * Authors one already-canonical mutation. Rust independently validates the
   * exact OGATX/OGASC bytes, resolves typed operations, applies atomically, and
   * returns the whole canonical OGACO transaction.
   */
  authorTransaction(intentBytes: Uint8Array, resolvedBaseBytes: Uint8Array): Uint8Array {
    assertSpreadsheetIntent(intentBytes);
    return this.session.authorTransaction(intentBytes, resolvedBaseBytes);
  }

  /** Encodes one identity-free typed command batch and authors it atomically. */
  authorCommands(
    input: NativeSpreadsheetAuthorCommandsInput,
  ): NativeSpreadsheetAuthoredTransaction {
    const commandBytes = encodeSpreadsheetArtifactCommandBatch(input.commands);
    const intentBytes = encodeEditableArtifactMutationIntent({
      ...input.intent,
      envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
      protocolVersion: 1,
      modelSchemaVersion: 1,
      commandProtocolVersion: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
      commandBytes,
    });
    const requestHash = hashEditableArtifactMutationIntentBytes(intentBytes);
    const committedTransactionBytes = this.authorTransaction(intentBytes, input.resolvedBaseBytes);
    return Object.freeze({ intentBytes, requestHash, committedTransactionBytes });
  }

  /** Replays one whole authoritative OGACO transaction atomically. */
  applyCommitted(committedTransactionBytes: Uint8Array): void {
    this.session.applyCommitted(committedTransactionBytes);
  }

  /**
   * Executes one canonical OGAKQ request. Typed viewport/metadata helpers use
   * the shared contract codec; this raw method remains useful at server byte
   * boundaries and never exposes a Rust object layout.
   */
  query(queryBytes: Uint8Array): Uint8Array {
    return this.session.query(queryBytes);
  }

  snapshot(): Uint8Array {
    return this.session.snapshot();
  }

  frontier(): Uint8Array {
    return this.session.frontier();
  }

  stateHash(): string {
    return this.session.stateHash();
  }

  revision(): bigint {
    return this.session.revision();
  }

  fork(): NativeSpreadsheetSession {
    return new NativeSpreadsheetSession(this.runtime, this.session.fork());
  }

  isClosed(): boolean {
    return this.session.isClosed();
  }

  dispose(): void {
    this.session.dispose();
  }
}

/** Exact synchronous N-API structured-document byte session. */
export class NativeDocumentSession {
  readonly kind = "native" as const;
  readonly modality = "document" as const;
  readonly target: NativeArtifactRuntimeTarget;
  readonly capabilities: ArtifactKernelCapabilities;
  readonly buildIdentity: string;

  private constructor(
    private readonly runtime: ArtifactKernelRuntime,
    private readonly session: ArtifactDocumentSession,
  ) {
    requireNativeRuntime(runtime);
    this.target = runtime.target as NativeArtifactRuntimeTarget;
    this.capabilities = runtime.capabilities;
    this.buildIdentity = runtime.buildIdentity;
  }

  static create(runtime: ArtifactKernelRuntime, namespace: bigint): NativeDocumentSession {
    requireNativeRuntime(runtime);
    return new NativeDocumentSession(runtime, runtime.createDocumentSession(namespace));
  }

  static open(runtime: ArtifactKernelRuntime, snapshot: Uint8Array): NativeDocumentSession {
    requireNativeRuntime(runtime);
    return new NativeDocumentSession(runtime, runtime.openDocumentSession(snapshot));
  }

  applyCommands(commands: Uint8Array): Uint8Array {
    return this.session.applyCommands(commands);
  }
  query(request: Uint8Array): Uint8Array {
    return this.session.query(request);
  }
  snapshot(): Uint8Array {
    return this.session.snapshot();
  }
  revision(): bigint {
    return this.session.revision();
  }
  stateHash(): string {
    return this.session.stateHash();
  }
  fork(): NativeDocumentSession {
    return new NativeDocumentSession(this.runtime, this.session.fork());
  }
  isClosed(): boolean {
    return this.session.isClosed();
  }
  dispose(): void {
    this.session.dispose();
  }
}

/** Exact synchronous N-API presentation byte session. */
export class NativePresentationSession {
  readonly kind = "native" as const;
  readonly modality = "presentation" as const;
  readonly target: NativeArtifactRuntimeTarget;
  readonly capabilities: ArtifactKernelCapabilities;
  readonly buildIdentity: string;

  private constructor(
    private readonly runtime: ArtifactKernelRuntime,
    private readonly session: ArtifactPresentationSession,
  ) {
    requireNativeRuntime(runtime);
    this.target = runtime.target as NativeArtifactRuntimeTarget;
    this.capabilities = runtime.capabilities;
    this.buildIdentity = runtime.buildIdentity;
  }

  static create(runtime: ArtifactKernelRuntime, namespace: bigint): NativePresentationSession {
    requireNativeRuntime(runtime);
    return new NativePresentationSession(runtime, runtime.createPresentationSession(namespace));
  }

  static open(runtime: ArtifactKernelRuntime, snapshot: Uint8Array): NativePresentationSession {
    requireNativeRuntime(runtime);
    return new NativePresentationSession(runtime, runtime.openPresentationSession(snapshot));
  }

  applyCommands(commands: Uint8Array): Uint8Array {
    return this.session.applyCommands(commands);
  }
  query(request: Uint8Array): Uint8Array {
    return this.session.query(request);
  }
  snapshot(): Uint8Array {
    return this.session.snapshot();
  }
  revision(): bigint {
    return this.session.revision();
  }
  stateHash(): string {
    return this.session.stateHash();
  }
  fork(): NativePresentationSession {
    return new NativePresentationSession(this.runtime, this.session.fork());
  }
  isClosed(): boolean {
    return this.session.isClosed();
  }
  dispose(): void {
    this.session.dispose();
  }
}

/** Exact synchronous N-API retained-font text-layout session. */
export class NativeTextLayoutSession {
  readonly kind = "native" as const;
  readonly modality = "text-layout" as const;
  readonly target: NativeArtifactRuntimeTarget;
  readonly capabilities: ArtifactKernelCapabilities;
  readonly buildIdentity: string;

  private constructor(
    private readonly session: ArtifactTextLayoutSession,
    runtime: ArtifactKernelRuntime,
  ) {
    requireNativeRuntime(runtime);
    this.target = runtime.target as NativeArtifactRuntimeTarget;
    this.capabilities = runtime.capabilities;
    this.buildIdentity = runtime.buildIdentity;
  }

  static open(runtime: ArtifactKernelRuntime, fontBundle: Uint8Array): NativeTextLayoutSession {
    requireNativeRuntime(runtime);
    return new NativeTextLayoutSession(runtime.openTextLayoutSession(fontBundle), runtime);
  }

  layout(request: Uint8Array): Uint8Array {
    return this.session.layout(request);
  }
  isClosed(): boolean {
    return this.session.isClosed();
  }
  dispose(): void {
    this.session.dispose();
  }
}

/** Creates a production modality session; unsupported Rust modes fail closed. */
export function createNativeArtifactSession(
  runtime: ArtifactKernelRuntime,
  input: CreateNativeArtifactSessionInput,
): NativeArtifactSession {
  if (input.modality === "spreadsheet") {
    return NativeSpreadsheetSession.create(runtime, input.replicaNamespace);
  }
  if (input.modality === "document") {
    return NativeDocumentSession.create(runtime, input.replicaNamespace);
  }
  return NativePresentationSession.create(runtime, input.replicaNamespace);
}

/** Opens a production modality session; unsupported Rust modes fail closed. */
export function openNativeArtifactSession(
  runtime: ArtifactKernelRuntime,
  input: OpenNativeArtifactSessionInput,
): NativeArtifactSession {
  if (input.modality === "spreadsheet")
    return NativeSpreadsheetSession.open(runtime, input.snapshot);
  if (input.modality === "document") return NativeDocumentSession.open(runtime, input.snapshot);
  return NativePresentationSession.open(runtime, input.snapshot);
}

function assertSpreadsheetIntent(intentBytes: Uint8Array): void {
  const intent = decodeEditableArtifactMutationIntent(intentBytes);
  if (
    intent.envelopeVersion !== EDITABLE_ARTIFACT_INTENT_VERSION ||
    intent.protocolVersion !== 1 ||
    intent.modelSchemaVersion !== 1 ||
    intent.commandProtocolVersion !== SPREADSHEET_ARTIFACT_COMMAND_VERSION
  ) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INCOMPATIBLE",
      "Spreadsheet intent versions do not match the loaded production kernel",
    );
  }
  assertCanonicalSpreadsheetArtifactCommandBytes(intent.commandBytes);
  // Hashing decodes again by design and proves the exact outer bytes are an
  // acceptable canonical request before they cross the native boundary.
  hashEditableArtifactMutationIntentBytes(intentBytes);
}

function requireNativeSpreadsheetRuntime(runtime: ArtifactKernelRuntime): void {
  requireNativeRuntime(runtime);
}

function requireNativeRuntime(runtime: ArtifactKernelRuntime): void {
  if (runtime.kind !== "native" || runtime.target === "wasm-web") {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      "NativeSpreadsheetSession requires an exact local N-API kernel; browser editing uses @opengeni/sdk/editable-artifacts",
    );
  }
}
