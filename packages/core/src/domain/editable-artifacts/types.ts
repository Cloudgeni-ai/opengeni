import type {
  EditableArtifactMutationIntent as ContractEditableArtifactMutationIntent,
  EDITABLE_ARTIFACT_INTENT_VERSION,
} from "@opengeni/contracts/editable-artifacts";
import { EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES } from "@opengeni/contracts/editable-artifacts";

/**
 * Domain vocabulary for collaborative, editable Office-like artifacts.
 *
 * This is intentionally unrelated to OpenGeni's published HTML artifacts and
 * document-ingestion records. An editable artifact is mutable canonical model
 * state plus a causally ordered operation history.
 */

declare const editableArtifactIdBrand: unique symbol;
declare const editableArtifactTransactionIdBrand: unique symbol;
declare const editableArtifactReceiptIdBrand: unique symbol;
declare const editableArtifactSnapshotIdBrand: unique symbol;
declare const editableArtifactOutboxIdBrand: unique symbol;
declare const editableArtifactOperationIdBrand: unique symbol;
declare const editableArtifactReplicaIdBrand: unique symbol;
declare const editableArtifactClientTransactionIdBrand: unique symbol;
declare const editableArtifactRequestHashBrand: unique symbol;
declare const editableArtifactStateHashBrand: unique symbol;
declare const editableArtifactContentHashBrand: unique symbol;

export type EditableArtifactId = string & {
  readonly [editableArtifactIdBrand]: true;
};
export type EditableArtifactTransactionId = string & {
  readonly [editableArtifactTransactionIdBrand]: true;
};
export type EditableArtifactReceiptId = string & {
  readonly [editableArtifactReceiptIdBrand]: true;
};
export type EditableArtifactSnapshotId = string & {
  readonly [editableArtifactSnapshotIdBrand]: true;
};
export type EditableArtifactOutboxId = string & {
  readonly [editableArtifactOutboxIdBrand]: true;
};
export type EditableArtifactOperationId = string & {
  readonly [editableArtifactOperationIdBrand]: true;
};
export type EditableArtifactReplicaId = string & {
  readonly [editableArtifactReplicaIdBrand]: true;
};
export type EditableArtifactClientTransactionId = string & {
  readonly [editableArtifactClientTransactionIdBrand]: true;
};
export type EditableArtifactRequestHash = string & {
  readonly [editableArtifactRequestHashBrand]: true;
};
export type EditableArtifactStateHash = string & {
  readonly [editableArtifactStateHashBrand]: true;
};
export type EditableArtifactContentHash = string & {
  readonly [editableArtifactContentHashBrand]: true;
};

export type EditableArtifactStableId =
  | EditableArtifactId
  | EditableArtifactTransactionId
  | EditableArtifactReceiptId
  | EditableArtifactSnapshotId
  | EditableArtifactOutboxId
  | EditableArtifactOperationId;

const STABLE_ID_PATTERN = /^[0-9a-f]{32}$/;
const REPLICA_ID_PATTERN = /^[0-9a-f]{16}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function assertNonzeroHex(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value) || /^0+$/.test(value)) {
    throw new TypeError(`${label} must be fixed-width lowercase nonzero hexadecimal text`);
  }
}

export function editableArtifactId(value: string): EditableArtifactId {
  assertNonzeroHex(value, STABLE_ID_PATTERN, "artifact id");
  return value as EditableArtifactId;
}

export function editableArtifactTransactionId(value: string): EditableArtifactTransactionId {
  assertNonzeroHex(value, STABLE_ID_PATTERN, "server transaction id");
  return value as EditableArtifactTransactionId;
}

export function editableArtifactReceiptId(value: string): EditableArtifactReceiptId {
  assertNonzeroHex(value, STABLE_ID_PATTERN, "receipt id");
  return value as EditableArtifactReceiptId;
}

export function editableArtifactSnapshotId(value: string): EditableArtifactSnapshotId {
  assertNonzeroHex(value, STABLE_ID_PATTERN, "snapshot id");
  return value as EditableArtifactSnapshotId;
}

export function editableArtifactOutboxId(value: string): EditableArtifactOutboxId {
  assertNonzeroHex(value, STABLE_ID_PATTERN, "outbox id");
  return value as EditableArtifactOutboxId;
}

export function editableArtifactOperationId(value: string): EditableArtifactOperationId {
  assertNonzeroHex(value, STABLE_ID_PATTERN, "operation id");
  return value as EditableArtifactOperationId;
}

export function editableArtifactReplicaId(value: string): EditableArtifactReplicaId {
  assertNonzeroHex(value, REPLICA_ID_PATTERN, "replica id");
  return value as EditableArtifactReplicaId;
}

export function editableArtifactClientTransactionId(
  value: string,
): EditableArtifactClientTransactionId {
  if (value.length < 1 || value.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new TypeError("client transaction id must contain 1-200 portable identifier characters");
  }
  return value as EditableArtifactClientTransactionId;
}

export function editableArtifactRequestHash(value: string): EditableArtifactRequestHash {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError("request hash must be sha256 followed by 64 lowercase hexadecimal digits");
  }
  return value as EditableArtifactRequestHash;
}

export function editableArtifactStateHash(value: string): EditableArtifactStateHash {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError("state hash must be sha256 followed by 64 lowercase hexadecimal digits");
  }
  return value as EditableArtifactStateHash;
}

export function editableArtifactContentHash(value: string): EditableArtifactContentHash {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError("content hash must be sha256 followed by 64 lowercase hexadecimal digits");
  }
  return value as EditableArtifactContentHash;
}

export type EditableArtifactScope = Readonly<{
  accountId: string;
  workspaceId: string;
}>;

export function editableArtifactScope(input: EditableArtifactScope): EditableArtifactScope {
  return Object.freeze({
    accountId: boundedIdentity(input.accountId, "account id"),
    workspaceId: boundedIdentity(input.workspaceId, "workspace id"),
  });
}

function boundedIdentity(value: string, label: string): string {
  if (
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    !isWellFormedPersistedText(value)
  ) {
    throw new TypeError(`${label} must contain 1-256 non-padding characters`);
  }
  return value;
}

function boundedActorIdentity(value: string, label: string): string {
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (
    value.length < 1 ||
    value.length > 256 ||
    byteLength > 1_024 ||
    value.trim() !== value ||
    !isWellFormedPersistedText(value)
  ) {
    throw new TypeError(
      `${label} must contain 1-256 well-formed non-padding characters and at most 1024 UTF-8 bytes`,
    );
  }
  return value;
}

function isWellFormedPersistedText(value: string): boolean {
  if (value.includes("\0")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export type EditableArtifactModality = "spreadsheet" | "presentation" | "document";
export type EditableArtifactLifecycleState = "active" | "archived";
export type EditableArtifactPermission =
  | "create"
  | "read"
  | "edit"
  | "import"
  | "export"
  | "manage";

export type EditableArtifactHumanActor = Readonly<{
  kind: "human";
  subjectId: string;
  replicaId: EditableArtifactReplicaId;
}>;

export type EditableArtifactAgentActor = Readonly<{
  kind: "agent";
  subjectId: string;
  replicaId: EditableArtifactReplicaId;
  sessionId: string;
  turnId: string;
  attemptId: string;
  generation: number;
}>;

export type EditableArtifactServiceActor = Readonly<{
  kind: "service";
  subjectId: string;
  replicaId: EditableArtifactReplicaId;
  service: string;
}>;

export type EditableArtifactActor =
  | EditableArtifactHumanActor
  | EditableArtifactAgentActor
  | EditableArtifactServiceActor;

export function validateEditableArtifactActor(actor: EditableArtifactActor): void {
  const record = exactPlainDataRecord(actor, "editable artifact actor");
  const kind = ownDataValue(record, "kind", "editable artifact actor");
  const allowed =
    kind === "human"
      ? ["kind", "subjectId", "replicaId"]
      : kind === "agent"
        ? ["kind", "subjectId", "replicaId", "sessionId", "turnId", "attemptId", "generation"]
        : kind === "service"
          ? ["kind", "subjectId", "replicaId", "service"]
          : null;
  if (!allowed) throw new TypeError("editable artifact actor kind is invalid");
  const names = Object.getOwnPropertyNames(record);
  if (names.length !== allowed.length || names.some((name) => !allowed.includes(name))) {
    throw new TypeError("editable artifact actor contains missing or unknown properties");
  }
  const subjectId = ownDataValue(record, "subjectId", "editable artifact actor");
  const replicaId = ownDataValue(record, "replicaId", "editable artifact actor");
  if (typeof subjectId !== "string" || typeof replicaId !== "string") {
    throw new TypeError("editable artifact actor identity is malformed");
  }
  boundedActorIdentity(subjectId, "actor subject id");
  editableArtifactReplicaId(replicaId);
  if (kind === "agent") {
    const sessionId = ownDataValue(record, "sessionId", "agent actor");
    const turnId = ownDataValue(record, "turnId", "agent actor");
    const attemptId = ownDataValue(record, "attemptId", "agent actor");
    const generation = ownDataValue(record, "generation", "agent actor");
    if (
      typeof sessionId !== "string" ||
      typeof turnId !== "string" ||
      typeof attemptId !== "string" ||
      typeof generation !== "number"
    ) {
      throw new TypeError("editable artifact agent actor is malformed");
    }
    boundedActorIdentity(sessionId, "agent session id");
    boundedActorIdentity(turnId, "agent turn id");
    boundedActorIdentity(attemptId, "agent attempt id");
    assertNonnegativeSafeInteger(generation, "agent generation");
  } else if (kind === "service") {
    const service = ownDataValue(record, "service", "service actor");
    if (typeof service !== "string") {
      throw new TypeError("editable artifact service actor is malformed");
    }
    boundedActorIdentity(service, "service name");
  }
}

function exactPlainDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not contain symbol properties`);
  }
  return value as Record<string, unknown>;
}

function ownDataValue(record: Record<string, unknown>, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    descriptor.enumerable !== true ||
    descriptor.value === undefined
  ) {
    throw new TypeError(`${label} property ${key} must be own data`);
  }
  return descriptor.value;
}

/** Exact authority identity used by idempotency and operation authorship. */
export function editableArtifactActorKey(actor: EditableArtifactActor): string {
  validateEditableArtifactActor(actor);
  let actorKey: string;
  switch (actor.kind) {
    case "human":
      actorKey = JSON.stringify([actor.kind, actor.subjectId]);
      break;
    case "agent":
      actorKey = JSON.stringify([
        actor.kind,
        actor.subjectId,
        actor.sessionId,
        actor.turnId,
        actor.attemptId,
        actor.generation,
      ]);
      break;
    case "service":
      actorKey = JSON.stringify([actor.kind, actor.subjectId, actor.service]);
      break;
    default:
      throw new TypeError("editable artifact actor kind is invalid");
  }
  if (new TextEncoder().encode(actorKey).byteLength > 8_192) {
    throw new TypeError("editable artifact actor key exceeds 8192 UTF-8 bytes");
  }
  return actorKey;
}

export type EditableArtifactCausalEntry = Readonly<{
  replicaId: EditableArtifactReplicaId;
  counter: number;
}>;

/** Sorted, duplicate-free semantic causality. Never substitute headSequence. */
export type EditableArtifactCausalFrontier = readonly EditableArtifactCausalEntry[];

export function editableArtifactCausalFrontier(
  entries: Iterable<EditableArtifactCausalEntry>,
): EditableArtifactCausalFrontier {
  const seen = new Set<string>();
  const normalized = [...entries].map((entry) => {
    const replicaId = editableArtifactReplicaId(entry.replicaId);
    assertPositiveSafeInteger(entry.counter, `causal counter for ${replicaId}`);
    if (seen.has(replicaId)) throw new TypeError(`duplicate causal replica: ${replicaId}`);
    seen.add(replicaId);
    return Object.freeze({ replicaId, counter: entry.counter });
  });
  normalized.sort((left, right) => compareCodeUnits(left.replicaId, right.replicaId));
  return Object.freeze(normalized);
}

export function causalCounter(
  frontier: EditableArtifactCausalFrontier,
  replicaId: EditableArtifactReplicaId,
): number {
  return frontier.find((entry) => entry.replicaId === replicaId)?.counter ?? 0;
}

export function causalFrontierDominates(
  candidate: EditableArtifactCausalFrontier,
  required: EditableArtifactCausalFrontier,
): boolean {
  return required.every((entry) => causalCounter(candidate, entry.replicaId) >= entry.counter);
}

export function causalFrontiersEqual(
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

export function mergeCausalFrontiers(
  ...frontiers: readonly EditableArtifactCausalFrontier[]
): EditableArtifactCausalFrontier {
  const counters = new Map<EditableArtifactReplicaId, number>();
  for (const frontier of frontiers) {
    for (const entry of frontier) {
      counters.set(entry.replicaId, Math.max(counters.get(entry.replicaId) ?? 0, entry.counter));
    }
  }
  return editableArtifactCausalFrontier(
    [...counters].map(([replicaId, counter]) => ({ replicaId, counter })),
  );
}

export type EditableArtifactCausalDot = EditableArtifactCausalEntry;

type EditableArtifactCommon = Readonly<{
  scope: EditableArtifactScope;
  id: EditableArtifactId;
  title: string;
  lifecycle: EditableArtifactLifecycleState;
  /** Local policy revision atomically fenced with every durable write. */
  authorizationRevision: number;
  headSequence: number;
  stateHash: EditableArtifactStateHash;
  currentSnapshotId: EditableArtifactSnapshotId | null;
  createdAt: string;
  updatedAt: string;
}>;

export type EditableArtifactSpreadsheet = EditableArtifactCommon &
  Readonly<{
    modality: "spreadsheet";
    causalFrontier: EditableArtifactCausalFrontier;
  }>;

export type EditableArtifactSerialized = EditableArtifactCommon &
  Readonly<{ modality: "document" | "presentation" }>;

export type EditableArtifact = EditableArtifactSpreadsheet | EditableArtifactSerialized;

export type CreateEditableArtifactRequest = Readonly<{
  idempotencyKey: EditableArtifactClientTransactionId;
  modality: EditableArtifactModality;
  title: string;
}>;

export type EditableArtifactOriginOperation = "create" | "import";
export const EDITABLE_ARTIFACT_ORIGINAL_IMPORT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Immutable, already-retained Office source for one imported artifact. The
 * object reference is infrastructure-owned; the remaining facts are bound into
 * the import idempotency hash and independently checked by the snapshot
 * verifier before publication.
 */
export type EditableArtifactOriginalImport = Readonly<{
  fileId: string;
  blobReference: string;
  byteSize: number;
  contentHash: EditableArtifactContentHash;
  mimeType:
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    | "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}>;

type ImportedEditableArtifactSnapshotRequest =
  PublishEditableArtifactSnapshotRequest extends infer Snapshot
    ? Snapshot extends PublishEditableArtifactSnapshotRequest
      ? Omit<Snapshot, "snapshotId" | "verifiedAt">
      : never
    : never;

export type ImportEditableArtifactRequest = Readonly<{
  idempotencyKey: EditableArtifactClientTransactionId;
  modality: EditableArtifactModality;
  title: string;
  originalImport: EditableArtifactOriginalImport;
  /** Snapshot identity and verification/publication timestamps remain server-owned. */
  snapshot: ImportedEditableArtifactSnapshotRequest;
}>;

export type EditableArtifactCreationReceipt = Readonly<{
  receiptId: EditableArtifactReceiptId;
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  operationKind: EditableArtifactOriginOperation;
  authorityKey: string;
  idempotencyKey: EditableArtifactClientTransactionId;
  /** Canonical hash of client semantics only; generated genesis facts are result data. */
  requestHash: EditableArtifactRequestHash;
  genesisSnapshotId: EditableArtifactSnapshotId;
  createdAt: string;
}>;

export type CreateEditableArtifactResult = Readonly<{
  artifact: EditableArtifact;
  genesisSnapshot: EditableArtifactSnapshotMetadata;
  creationReceipt: EditableArtifactCreationReceipt;
  replayed: boolean;
}>;

/** Exact decoded shared OGATX001 contract; never independently recanonicalized. */
export type EditableArtifactMutationIntent = ContractEditableArtifactMutationIntent;

/** Server-validated/branded projection of the exact decoded shared contract. */
export type ValidatedEditableArtifactMutationIntent = Readonly<{
  envelopeVersion: typeof EDITABLE_ARTIFACT_INTENT_VERSION;
  protocolVersion: number;
  modelSchemaVersion: number;
  commandProtocolVersion: number;
  artifactId: EditableArtifactId;
  clientTransactionId: EditableArtifactClientTransactionId;
  replicaId: EditableArtifactReplicaId;
  /** One persisted counter is reserved per atomic local transaction. */
  replicaCounter: number;
  /** Null only for the first transaction authored by this replica. */
  previousLocalTransactionId: EditableArtifactClientTransactionId | null;
  observedHeadSequence: number;
  causalBase: EditableArtifactCausalFrontier;
  selectiveUndoOperationIds: readonly EditableArtifactOperationId[];
  /** Canonical client commands; only the authoritative kernel may decode them. */
  commandBytes: Uint8Array;
}>;

export type ApplyEditableArtifactTransactionRequest = Readonly<{
  /** Exact owned canonical OGATX001 bytes. */
  intentBytes: Uint8Array;
  requestHash: EditableArtifactRequestHash;
}>;

/** Metadata indexed for authorship/selective undo; command data stays in OGACO. */
export type EditableArtifactKernelOperation = Readonly<{
  operationId: EditableArtifactOperationId;
  dot: EditableArtifactCausalDot;
}>;

export type EditableArtifactOperationRecord = EditableArtifactKernelOperation &
  Readonly<{
    scope: EditableArtifactScope;
    artifactId: EditableArtifactId;
    serverTransactionId: EditableArtifactTransactionId;
    sequence: number;
    actorKey: string;
    createdAt: string;
  }>;

/**
 * One exact canonical OGACO transaction. The opaque bytes are the sole
 * authoritative operation payload and are replayed atomically by the native
 * or WASM kernel. Core never decodes modality commands from this envelope.
 */
type EditableArtifactCommittedTransactionCommon = Readonly<{
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  serverTransactionId: EditableArtifactTransactionId;
  requestHash: EditableArtifactRequestHash;
  sequenceStart: number;
  sequenceEnd: number;
  priorStateHash: EditableArtifactStateHash;
  stateHash: EditableArtifactStateHash;
  modelSchemaVersion: number;
  kernelVersion: string;
  committedTransactionBytes: Uint8Array;
  committedAt: string;
}>;

export type EditableArtifactSpreadsheetCommittedTransactionRecord =
  EditableArtifactCommittedTransactionCommon &
    Readonly<{
      modality: "spreadsheet";
      dot: EditableArtifactCausalDot;
      resolvedCausalBase: EditableArtifactCausalFrontier;
      resultingCausalFrontier: EditableArtifactCausalFrontier;
      operationIds: readonly EditableArtifactOperationId[];
      operationProtocolVersion: number;
    }>;

export type EditableArtifactSerializedCommittedTransactionRecord =
  EditableArtifactCommittedTransactionCommon &
    Readonly<{
      modality: "document" | "presentation";
      commitProtocolVersion: number;
      priorNativeRevision: number;
      nativeRevision: number;
      commandCount: number;
      nativeReceiptBytes: Uint8Array;
    }>;

export type EditableArtifactCommittedTransactionRecord =
  | EditableArtifactSpreadsheetCommittedTransactionRecord
  | EditableArtifactSerializedCommittedTransactionRecord;

type EditableArtifactReceiptCommon = Readonly<{
  receiptId: EditableArtifactReceiptId;
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  serverTransactionId: EditableArtifactTransactionId;
  clientTransactionId: EditableArtifactClientTransactionId;
  replicaId: EditableArtifactReplicaId;
  replicaCounter: number;
  previousLocalTransactionId: EditableArtifactClientTransactionId | null;
  requestHash: EditableArtifactRequestHash;
  /** Exact canonical bytes whose SHA-256 is requestHash. */
  intentBytes: Uint8Array;
  actorKey: string;
  sequenceStart: number;
  sequenceEnd: number;
  priorStateHash: EditableArtifactStateHash;
  stateHash: EditableArtifactStateHash;
  intentEnvelopeVersion: number;
  intentProtocolVersion: number;
  commandProtocolVersion: number;
  kernelVersion: string;
  modelSchemaVersion: number;
  committedAt: string;
}>;

export type EditableArtifactSpreadsheetReceipt = EditableArtifactReceiptCommon &
  Readonly<{
    modality: "spreadsheet";
    causalBase: EditableArtifactCausalFrontier;
    resolvedCausalBase: EditableArtifactCausalFrontier;
    resultingCausalFrontier: EditableArtifactCausalFrontier;
    stateHash: EditableArtifactStateHash;
    operationCount: number;
    selectiveUndoOperationIds: readonly EditableArtifactOperationId[];
    operationProtocolVersion: number;
  }>;

export type EditableArtifactSerializedReceipt = EditableArtifactReceiptCommon &
  Readonly<{
    modality: "document" | "presentation";
    commitProtocolVersion: number;
    priorNativeRevision: number;
    nativeRevision: number;
    commandCount: number;
  }>;

export type EditableArtifactReceipt =
  | EditableArtifactSpreadsheetReceipt
  | EditableArtifactSerializedReceipt;

export type ApplyEditableArtifactTransactionResult = Readonly<{
  receipt: EditableArtifactReceipt;
  replayed: boolean;
}>;

type EditableArtifactSnapshotMetadataCommon = Readonly<{
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  snapshotId: EditableArtifactSnapshotId;
  blobReference: string;
  byteSize: number;
  contentHash: EditableArtifactContentHash;
  mimeType: "application/vnd.opengeni.editable-artifact-snapshot";
  coveredHeadSequence: number;
  stateHash: EditableArtifactStateHash;
  modelSchemaVersion: number;
  kernelVersion: string;
  verifiedAt: string;
  publishedAt: string;
}>;

export type EditableArtifactSpreadsheetSnapshotMetadata = EditableArtifactSnapshotMetadataCommon &
  Readonly<{
    modality: "spreadsheet";
    coveredCausalFrontier: EditableArtifactCausalFrontier;
    operationProtocolVersion: number;
    crdtStateVersion: number;
  }>;

export type EditableArtifactSerializedSnapshotMetadata = EditableArtifactSnapshotMetadataCommon &
  Readonly<{
    modality: "document" | "presentation";
    nativeRevision: number;
  }>;

export type EditableArtifactSnapshotMetadata =
  | EditableArtifactSpreadsheetSnapshotMetadata
  | EditableArtifactSerializedSnapshotMetadata;

export type PublishEditableArtifactSnapshotRequest =
  EditableArtifactSnapshotMetadata extends infer Snapshot
    ? Snapshot extends EditableArtifactSnapshotMetadata
      ? Omit<Snapshot, "scope" | "artifactId" | "publishedAt">
      : never
    : never;

type EditableArtifactTransactionCommittedEventCommon = Readonly<{
  kind: "transaction_committed";
  schemaVersion: 1;
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  serverTransactionId: EditableArtifactTransactionId;
  sequenceStart: number;
  sequenceEnd: number;
  stateHash: EditableArtifactStateHash;
  committedAt: string;
}>;

export type EditableArtifactTransactionCommittedEvent =
  | (EditableArtifactTransactionCommittedEventCommon &
      Readonly<{ modality: "spreadsheet"; operationProtocolVersion: number }>)
  | (EditableArtifactTransactionCommittedEventCommon &
      Readonly<{
        modality: "document" | "presentation";
        commitProtocolVersion: number;
      }>);

type EditableArtifactSnapshotPublishedEventCommon = Readonly<{
  kind: "snapshot_published";
  schemaVersion: 1;
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  snapshotId: EditableArtifactSnapshotId;
  coveredHeadSequence: number;
  stateHash: EditableArtifactStateHash;
  publishedAt: string;
}>;

export type EditableArtifactSnapshotPublishedEvent =
  | (EditableArtifactSnapshotPublishedEventCommon &
      Readonly<{ modality: "spreadsheet"; operationProtocolVersion: number }>)
  | (EditableArtifactSnapshotPublishedEventCommon &
      Readonly<{ modality: "document" | "presentation" }>);

/** Durable live fanout hint. Consumers gap-fill canonical transactions. */
export type EditableArtifactLiveEvent =
  | EditableArtifactTransactionCommittedEvent
  | EditableArtifactSnapshotPublishedEvent;

export type EditableArtifactOutboxRetryFailureCode =
  | "broker_unavailable"
  | "broker_backpressure"
  | "publish_timeout";

export type EditableArtifactOutboxDeadLetterFailureCode = "invalid_hint" | "oversized_hint";

export type EditableArtifactOutboxErrorCode =
  | EditableArtifactOutboxRetryFailureCode
  | EditableArtifactOutboxDeadLetterFailureCode;

export type EditableArtifactLiveOutboxRecord = Readonly<{
  outboxId: EditableArtifactOutboxId;
  event: EditableArtifactLiveEvent;
  state: "pending" | "publishing" | "published" | "dead_lettered";
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string;
  lastErrorCode: EditableArtifactOutboxErrorCode | null;
  publishedAt: string | null;
  deadLetteredAt: string | null;
  createdAt: string;
}>;

export type EditableArtifactSequenceCheckpoint =
  | Readonly<{
      modality: "spreadsheet";
      headSequence: number;
      causalFrontier: EditableArtifactCausalFrontier;
      stateHash: EditableArtifactStateHash;
    }>
  | Readonly<{
      modality: "document" | "presentation";
      headSequence: number;
      nativeRevision: number;
      stateHash: EditableArtifactStateHash;
    }>;

export function assertNonnegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
}

export function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

export function assertIsoTimestamp(value: string, label: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp`);
  }
}

export function assertBoundedArtifactTitle(value: string): void {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 1 || bytes > 512 || value.trim() !== value || !isWellFormedPersistedText(value)) {
    throw new TypeError("artifact title must contain 1-512 UTF-8 bytes without padding");
  }
}

export function assertBoundedOpaqueReference(value: string, label: string): void {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 1 || bytes > 1024 || value.trim() !== value || !isWellFormedPersistedText(value)) {
    throw new TypeError(`${label} must contain 1-1024 UTF-8 bytes without padding`);
  }
}

export function assertBoundedKernelVersion(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError("kernel version must be a string");
  }
  const bytes = new TextEncoder().encode(value).byteLength;
  if (
    bytes < 1 ||
    bytes > EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES ||
    value.trim() !== value ||
    !isWellFormedPersistedText(value)
  ) {
    throw new TypeError(
      `kernel version must contain 1-${EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES} well-formed UTF-8 bytes without padding`,
    );
  }
}

/** Locale-independent ordering used by every canonical wire/hash projection. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
