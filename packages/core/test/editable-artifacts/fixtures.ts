import {
  EDITABLE_ARTIFACT_INTENT_VERSION,
  hashEditableArtifactMutationIntent,
} from "@opengeni/contracts/editable-artifacts";
import {
  decodeSpreadsheetArtifactCommandBatch,
  encodeSpreadsheetArtifactCommandBatch,
  spreadsheetSheetId,
} from "@opengeni/contracts/spreadsheet-artifact-commands";
import {
  decodeDocumentArtifactCommandBatch,
  encodeDocumentArtifactCommandBatch,
} from "@opengeni/contracts/document-artifact-commands";
import {
  decodePresentationArtifactCommandBatch,
  encodePresentationArtifactCommandBatch,
} from "@opengeni/contracts/presentation-artifact-commands";
import { createHash } from "node:crypto";

import type {
  ApplyAuthoritativeEditableArtifactKernelRequest,
  ApplyAuthoritativeEditableArtifactKernelResult,
  AuthoritativeEditableArtifactKernelPort,
  EditableArtifactAuthorizationPort,
  EditableArtifactClockPort,
  EditableArtifactCompactionPort,
  EditableArtifactGenesisPort,
  EditableArtifactSnapshotVerifierPort,
} from "../../src/domain/editable-artifacts/ports";
import {
  InMemoryEditableArtifactStableIdFactory,
  InMemoryEditableArtifactStore,
} from "../../src/domain/editable-artifacts/in-memory";
import { ogatxEditableArtifactMutationIntentCodec } from "../../src/domain/editable-artifacts/hash";
import { EditableArtifactService } from "../../src/domain/editable-artifacts/service";
import {
  causalCounter,
  editableArtifactCausalFrontier,
  editableArtifactContentHash,
  editableArtifactId,
  editableArtifactOperationId,
  editableArtifactReplicaId,
  editableArtifactRequestHash,
  editableArtifactSnapshotId,
  editableArtifactStateHash,
  editableArtifactTransactionId,
  mergeCausalFrontiers,
  type ApplyEditableArtifactTransactionRequest,
  type EditableArtifactActor,
  type EditableArtifactMutationIntent,
  type EditableArtifactPermission,
  type PublishEditableArtifactSnapshotRequest,
} from "../../src/domain/editable-artifacts/types";

export const scope = Object.freeze({
  accountId: "acct-a",
  workspaceId: "workspace-a",
});
export const otherScope = Object.freeze({
  accountId: "acct-a",
  workspaceId: "workspace-b",
});
export const artifactId = editableArtifactId(stableHex(1, 1));
export const initialStateHash = hash(1);

export const humanActor: EditableArtifactActor = Object.freeze({
  kind: "human",
  subjectId: "user:one",
  replicaId: editableArtifactReplicaId("0000000000000001"),
});

export const otherHumanActor: EditableArtifactActor = Object.freeze({
  kind: "human",
  subjectId: "user:two",
  replicaId: editableArtifactReplicaId("0000000000000002"),
});

export class TestArtifactAuthorization implements EditableArtifactAuthorizationPort {
  readonly calls: Array<Parameters<EditableArtifactAuthorizationPort["authorize"]>[0]> = [];
  private readonly denied = new Set<EditableArtifactPermission>();
  private readonly deniedSubjects = new Map<string, Set<EditableArtifactPermission>>();

  constructor(private revision = 1) {}

  deny(permission: EditableArtifactPermission): void {
    this.denied.add(permission);
  }

  allow(permission: EditableArtifactPermission): void {
    this.denied.delete(permission);
  }

  denySubject(subjectId: string, permission: EditableArtifactPermission): void {
    const permissions = this.deniedSubjects.get(subjectId) ?? new Set<EditableArtifactPermission>();
    permissions.add(permission);
    this.deniedSubjects.set(subjectId, permissions);
  }

  setRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new TypeError("authorization revision must be positive");
    }
    this.revision = revision;
  }

  async authorize(
    input: Parameters<EditableArtifactAuthorizationPort["authorize"]>[0],
  ): ReturnType<EditableArtifactAuthorizationPort["authorize"]> {
    this.calls.push(input);
    return Promise.resolve(
      Object.freeze({
        allowed:
          !this.denied.has(input.permission) &&
          !this.deniedSubjects.get(input.actor.subjectId)?.has(input.permission),
        revision: this.revision,
      }),
    );
  }
}

export class TestArtifactClock implements EditableArtifactClockPort {
  constructor(private value = new Date("2026-08-08T10:00:00.000Z")) {}

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

export class TestArtifactSnapshotVerifier implements EditableArtifactSnapshotVerifierPort {
  readonly calls: Array<Parameters<EditableArtifactSnapshotVerifierPort["verify"]>[0]> = [];
  failure: Error | null = null;
  wait: Promise<void> | null = null;

  async verify(
    input: Parameters<EditableArtifactSnapshotVerifierPort["verify"]>[0],
  ): Promise<void> {
    this.calls.push(input);
    if (this.wait) await this.wait;
    if (this.failure) throw this.failure;
  }
}

export class TestArtifactGenesis implements EditableArtifactGenesisPort {
  readonly calls: Array<Parameters<EditableArtifactGenesisPort["prepare"]>[0]> = [];
  failure: Error | null = null;
  wait: Promise<void> | null = null;

  async prepare(
    input: Parameters<EditableArtifactGenesisPort["prepare"]>[0],
  ): Promise<PublishEditableArtifactSnapshotRequest> {
    this.calls.push(input);
    if (this.wait) await this.wait;
    if (this.failure) throw this.failure;
    const common = {
      snapshotId: input.snapshotId,
      blobReference: `blob:genesis-${input.artifactId}`,
      byteSize: 1_024,
      contentHash: editableArtifactContentHash(hash(500)),
      mimeType: "application/vnd.opengeni.editable-artifact-snapshot",
      modality: input.modality,
      coveredHeadSequence: 0,
      stateHash: initialStateHash,
      modelSchemaVersion: 1,
      kernelVersion: "test-kernel/1",
      verifiedAt: "2026-08-08T09:59:00.000Z",
    } as const;
    return input.modality === "spreadsheet"
      ? Object.freeze({
          ...common,
          modality: "spreadsheet" as const,
          coveredCausalFrontier: editableArtifactCausalFrontier([]),
          operationProtocolVersion: 1,
          crdtStateVersion: 1,
        })
      : Object.freeze({
          ...common,
          modality: input.modality,
          nativeRevision: 0,
        });
  }
}

export class TestArtifactCompaction implements EditableArtifactCompactionPort {
  readonly calls: Array<Parameters<EditableArtifactCompactionPort["prepare"]>[0]> = [];
  wait: Promise<void> | null = null;

  async prepare(
    input: Parameters<EditableArtifactCompactionPort["prepare"]>[0],
  ): Promise<PublishEditableArtifactSnapshotRequest> {
    this.calls.push(input);
    if (this.wait) await this.wait;
    const artifact = input.state.artifact;
    const common = {
      snapshotId: input.snapshotId,
      blobReference: `blob:compacted-${input.snapshotId}`,
      byteSize: 2_048,
      contentHash: editableArtifactContentHash(hash(800 + artifact.headSequence)),
      mimeType: "application/vnd.opengeni.editable-artifact-snapshot",
      modality: artifact.modality,
      coveredHeadSequence: artifact.headSequence,
      stateHash: artifact.stateHash,
      modelSchemaVersion: 1,
      kernelVersion: "test-kernel/1",
      verifiedAt: "2026-08-08T09:59:30.000Z",
    } as const;
    if (artifact.modality === "spreadsheet") {
      return Object.freeze({
        ...common,
        modality: artifact.modality,
        coveredCausalFrontier: artifact.causalFrontier,
        operationProtocolVersion: 1,
        crdtStateVersion: 1,
      });
    }
    const serialized = input.state;
    if (serialized.modality === "spreadsheet") throw new Error("Compaction modality mismatch");
    return Object.freeze({
      ...common,
      modality: artifact.modality,
      nativeRevision:
        serialized.committedTransactionTail.at(-1)?.nativeRevision ??
        serialized.snapshot?.nativeRevision ??
        serialized.baseNativeRevision,
    });
  }
}

export class TestAuthoritativeKernel implements AuthoritativeEditableArtifactKernelPort {
  readonly calls: ApplyAuthoritativeEditableArtifactKernelRequest[] = [];
  corrupt?: (
    result: ApplyAuthoritativeEditableArtifactKernelResult,
    input: ApplyAuthoritativeEditableArtifactKernelRequest,
  ) => ApplyAuthoritativeEditableArtifactKernelResult;
  failure: Error | null = null;
  wait: Promise<void> | null = null;
  async applyTransaction(
    input: ApplyAuthoritativeEditableArtifactKernelRequest,
  ): Promise<ApplyAuthoritativeEditableArtifactKernelResult> {
    this.calls.push(input);
    if (this.wait) await this.wait;
    if (this.failure) throw this.failure;
    if (input.modality !== "spreadsheet") {
      const count =
        input.modality === "document"
          ? decodeDocumentArtifactCommandBatch(input.intent.commandBytes).commands.length
          : decodePresentationArtifactCommandBatch(input.intent.commandBytes).commands.length;
      const priorNativeRevision =
        input.state.committedTransactionTail.at(-1)?.nativeRevision ??
        input.state.snapshot?.nativeRevision ??
        0;
      const result: ApplyAuthoritativeEditableArtifactKernelResult = {
        modality: input.modality,
        nativeReceiptBytes: encodeSerializedTestReceipt(
          input.modality,
          priorNativeRevision + 1,
          count,
        ),
        resultingStateHash: hash(input.state.artifact.headSequence + count + 700),
        kernelVersion: "test-kernel/1",
        modelSchemaVersion: 1,
      };
      return this.corrupt ? this.corrupt(result, input) : result;
    }
    const count = decodeSpreadsheetArtifactCommandBatch(input.intent.commandBytes).commands.length;
    const operationIds = Array.from({ length: count }, (_, index) =>
      editableArtifactOperationId(
        deriveKernelId("opengeni:artifact:op:v1\0", input.requestHash, index),
      ),
    );
    const dot = Object.freeze({
      replicaId: input.actor.replicaId,
      counter: input.intent.replicaCounter,
    });
    const resultingCausalFrontier = mergeCausalFrontiers(
      input.state.artifact.causalFrontier,
      editableArtifactCausalFrontier([dot]),
    );
    const serverTransactionId = editableArtifactTransactionId(
      deriveKernelId("opengeni:artifact:tx:v1\0", input.requestHash),
    );
    const stateHash = hash(input.state.artifact.headSequence + count + 100);
    const result: ApplyAuthoritativeEditableArtifactKernelResult = {
      modality: "spreadsheet",
      committedTransactionBytes: encodeTestCommittedTransaction({
        transactionId: serverTransactionId,
        dot,
        resolvedCausalBase: input.resolvedCausalBase,
        operationIds,
        priorStateHash: input.state.artifact.stateHash,
        resultingCausalFrontier,
        stateHash,
      }),
      kernelVersion: "test-kernel/1",
      modelSchemaVersion: 1,
    };
    return this.corrupt ? this.corrupt(result, input) : result;
  }
}

type TestCommittedTransactionInput = Readonly<{
  transactionId: string;
  dot: Readonly<{ replicaId: string; counter: number }>;
  resolvedCausalBase: readonly Readonly<{
    replicaId: string;
    counter: number;
  }>[];
  operationIds: readonly string[];
  priorStateHash: string;
  resultingCausalFrontier: readonly Readonly<{
    replicaId: string;
    counter: number;
  }>[];
  stateHash: string;
}>;

/** Test-only OGACO encoder. Production can author these bytes only in Rust. */
export function encodeTestCommittedTransaction(input: TestCommittedTransactionInput): Uint8Array {
  const payload = new TestCommittedWriter()
    .stableId(input.transactionId)
    .u64(BigInt(`0x${input.dot.replicaId}`))
    .u64(BigInt(input.dot.counter))
    .frontier(input.resolvedCausalBase)
    .hash(input.priorStateHash);
  for (const operationId of input.operationIds) {
    // A canonical selective-undo command is sufficient for this domain fake;
    // the production path never uses this encoder or interprets OGACO in TS.
    payload.stableId(operationId).u8(5).stableId(operationId);
  }
  payload.frontier(input.resultingCausalFrontier).hash(input.stateHash);
  const payloadBytes = payload.finish();
  const envelope = new TestCommittedWriter()
    .raw(new TextEncoder().encode("OGACO001"))
    .u16(1)
    .u16(0)
    .u32(input.operationIds.length)
    .u64(BigInt(payloadBytes.byteLength))
    .raw(payloadBytes)
    .raw(new Uint8Array(8))
    .finish();
  const payloadEnd = envelope.byteLength - 8;
  new DataView(envelope.buffer).setBigUint64(
    payloadEnd,
    fnv1a64(envelope.subarray(0, payloadEnd)),
    true,
  );
  return envelope;
}

class TestCommittedWriter {
  private readonly bytes: number[] = [];

  raw(bytes: Uint8Array): this {
    this.bytes.push(...bytes);
    return this;
  }

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value).u8(value >>> 8);
  }

  u32(value: number): this {
    return this.u8(value)
      .u8(value >>> 8)
      .u8(value >>> 16)
      .u8(value >>> 24);
  }

  u64(value: bigint): this {
    return this.u32(Number(value & 0xffff_ffffn)).u32(Number((value >> 32n) & 0xffff_ffffn));
  }

  stableId(value: string): this {
    return this.u64(BigInt(`0x${value.slice(16)}`)).u64(BigInt(`0x${value.slice(0, 16)}`));
  }

  frontier(entries: readonly Readonly<{ replicaId: string; counter: number }>[]): this {
    this.u32(entries.length);
    for (const entry of entries) {
      this.u64(BigInt(`0x${entry.replicaId}`)).u64(BigInt(entry.counter));
    }
    return this;
  }

  hash(value: string): this {
    return this.raw(Uint8Array.from(Buffer.from(value.slice(7), "hex")));
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function fnv1a64(bytes: Uint8Array): bigint {
  let digest = 0xcbf2_9ce4_8422_2325n;
  for (const byte of bytes) {
    digest ^= BigInt(byte);
    digest = (digest * 0x100_0000_01b3n) & 0xffff_ffff_ffff_ffffn;
  }
  return digest;
}

export function encodeSerializedTestReceipt(
  modality: "document" | "presentation",
  revision: number,
  commandCount: number,
): Uint8Array {
  if (modality === "document") {
    const payload = new TestCommittedWriter()
      .u64(BigInt(revision))
      .u32(commandCount)
      .u32(0)
      .finish();
    const envelope = new TestCommittedWriter()
      .raw(new TextEncoder().encode("OGADR001"))
      .u16(1)
      .u16(0)
      .u32(commandCount)
      .u64(BigInt(payload.byteLength))
      .raw(payload)
      .raw(new Uint8Array(8))
      .finish();
    new DataView(envelope.buffer).setBigUint64(
      envelope.byteLength - 8,
      fnv1a64(envelope.subarray(0, envelope.byteLength - 8)),
      true,
    );
    return envelope;
  }
  const receipt = new TestCommittedWriter()
    .raw(new TextEncoder().encode("OGAPR001"))
    .u16(1)
    .u16(0)
    .u64(BigInt(revision))
    .u32(commandCount)
    .raw(new Uint8Array(8))
    .finish();
  new DataView(receipt.buffer).setBigUint64(
    receipt.byteLength - 8,
    fnv1a64(receipt.subarray(0, receipt.byteLength - 8)),
    true,
  );
  return receipt;
}

function deriveKernelId(domain: string, requestHash: string, index?: number): string {
  const digest = Buffer.from(requestHash.slice("sha256:".length), "hex");
  const hasher = createHash("sha256").update(domain).update(digest);
  if (index !== undefined) {
    const encoded = Buffer.allocUnsafe(4);
    encoded.writeUInt32LE(index);
    hasher.update(encoded);
  }
  return hasher.digest("hex").slice(0, 32);
}

export async function artifactFixture(input?: {
  lifecycle?: "active" | "archived";
  scope?: typeof scope;
  authorizationRevision?: number;
  seed?: boolean;
  modality?: "spreadsheet" | "document" | "presentation";
  compaction?: EditableArtifactCompactionPort;
}) {
  const clock = new TestArtifactClock();
  const store = new InMemoryEditableArtifactStore(() => clock.now());
  const authorization = new TestArtifactAuthorization(input?.authorizationRevision ?? 1);
  const kernel = new TestAuthoritativeKernel();
  const snapshotVerifier = new TestArtifactSnapshotVerifier();
  const genesis = new TestArtifactGenesis();
  const intentCodec = ogatxEditableArtifactMutationIntentCodec;
  const service = new EditableArtifactService({
    store,
    authorization,
    kernel,
    clock,
    ids: new InMemoryEditableArtifactStableIdFactory(0x10n),
    intentCodec,
    snapshotVerifier,
    genesis,
    ...(input?.compaction ? { compaction: input.compaction } : {}),
  });
  if (input?.seed !== false) {
    await store.seedArtifact({
      scope: input?.scope ?? scope,
      artifactId,
      modality: input?.modality ?? "spreadsheet",
      title: "Budget",
      stateHash: initialStateHash,
      authorizationRevision: input?.authorizationRevision ?? 1,
      ...(input?.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
      createdAt: "2026-08-08T09:00:00.000Z",
    });
  }
  return {
    store,
    authorization,
    kernel,
    intentCodec,
    snapshotVerifier,
    genesis,
    clock,
    service,
  };
}

export async function transactionRequest(
  _service: EditableArtifactService,
  input?: Partial<
    Pick<
      EditableArtifactMutationIntent,
      | "protocolVersion"
      | "modelSchemaVersion"
      | "commandProtocolVersion"
      | "clientTransactionId"
      | "replicaCounter"
      | "previousLocalTransactionId"
      | "observedHeadSequence"
      | "causalBase"
      | "selectiveUndoOperationIds"
      | "commandBytes"
    >
  > & {
    actor?: EditableArtifactActor;
    scope?: typeof scope;
    commands?: readonly unknown[];
    modality?: "spreadsheet" | "document" | "presentation";
    artifactId?: typeof artifactId;
  },
): Promise<
  ApplyEditableArtifactTransactionRequest &
    Readonly<{
      intent: EditableArtifactMutationIntent;
      clientTransactionId: EditableArtifactMutationIntent["clientTransactionId"];
    }>
> {
  const actor = input?.actor ?? humanActor;
  const causalBase = input?.causalBase ?? editableArtifactCausalFrontier([]);
  const commandCount = Math.max(1, input?.commands?.length ?? 1);
  const commandVariant = input?.commands ? JSON.stringify(input.commands) : undefined;
  const commandBytes =
    input?.commandBytes ??
    editableArtifactTestCommandBytes(
      input?.modality ?? "spreadsheet",
      commandCount,
      commandVariant,
    );
  const intent: EditableArtifactMutationIntent = {
    envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
    protocolVersion: input?.protocolVersion ?? 1,
    modelSchemaVersion: input?.modelSchemaVersion ?? 1,
    commandProtocolVersion: input?.commandProtocolVersion ?? 1,
    artifactId: input?.artifactId ?? artifactId,
    clientTransactionId: input?.clientTransactionId ?? (`client-${crypto.randomUUID()}` as never),
    replicaId: actor.replicaId,
    replicaCounter: input?.replicaCounter ?? causalCounter(causalBase, actor.replicaId) + 1,
    previousLocalTransactionId: input?.previousLocalTransactionId ?? null,
    observedHeadSequence: input?.observedHeadSequence ?? 0,
    causalBase,
    selectiveUndoOperationIds: Object.freeze([...(input?.selectiveUndoOperationIds ?? [])].sort()),
    commandBytes,
  };
  const encoded = hashEditableArtifactMutationIntent(intent);
  const intentBytes = encoded.bytes;
  const requestHash = editableArtifactRequestHash(encoded.requestHash);
  const envelope = {
    intentBytes,
    requestHash,
  } as ApplyEditableArtifactTransactionRequest &
    Readonly<{
      intent: EditableArtifactMutationIntent;
      clientTransactionId: EditableArtifactMutationIntent["clientTransactionId"];
    }>;
  Object.defineProperties(envelope, {
    intent: { value: intent, enumerable: false },
    clientTransactionId: {
      value: intent.clientTransactionId,
      enumerable: false,
    },
  });
  return Object.freeze(envelope);
}

export function snapshotRequest(input: {
  snapshotCounter?: number;
  coveredHeadSequence: number;
  coveredCausalFrontier: Extract<
    PublishEditableArtifactSnapshotRequest,
    { modality: "spreadsheet" }
  >["coveredCausalFrontier"];
  stateHash: PublishEditableArtifactSnapshotRequest["stateHash"];
}): PublishEditableArtifactSnapshotRequest {
  return {
    modality: "spreadsheet",
    snapshotId: editableArtifactSnapshotId(stableHex(4, input.snapshotCounter ?? 1)),
    blobReference: `blob:snapshot-${input.snapshotCounter ?? 1}`,
    byteSize: 1024,
    contentHash: editableArtifactContentHash(hash(input.snapshotCounter ?? 500)),
    mimeType: "application/vnd.opengeni.editable-artifact-snapshot",
    coveredHeadSequence: input.coveredHeadSequence,
    coveredCausalFrontier: input.coveredCausalFrontier,
    stateHash: input.stateHash,
    modelSchemaVersion: 1,
    operationProtocolVersion: 1,
    kernelVersion: "test-kernel/1",
    crdtStateVersion: 1,
    verifiedAt: "2026-08-08T09:59:00.000Z",
  };
}

export function editableArtifactTestCommandBytes(
  modality: "spreadsheet" | "document" | "presentation",
  count = 1,
  variant?: string,
): Uint8Array {
  if (!Number.isInteger(count) || count < 1) {
    throw new TypeError("test command count must be positive");
  }
  if (modality === "document") {
    return encodeDocumentArtifactCommandBatch({
      version: 1,
      commands: Array.from({ length: count }, (_, index) => ({
        kind: "document.flags.set" as const,
        evenAndOddHeaders: index % 2 === 0,
        trackRevisions: index % 2 === 1,
      })),
    });
  }
  if (modality === "presentation") {
    return encodePresentationArtifactCommandBatch({
      version: 1,
      commands: Array.from({ length: count }, (_, index) => ({
        kind: "master.create" as const,
        id: stableHex(0xa00 + index, 1),
        name: `Master ${index + 1}`,
        background: { kind: "none" as const },
      })),
    });
  }
  return encodeSpreadsheetArtifactCommandBatch({
    version: 1,
    commands: Array.from({ length: count }, (_, index) => ({
      kind: "sheet.create" as const,
      sheetId: spreadsheetSheetId(stableHex(0x900 + index, 1 + testVariantHash(variant))),
      name: variant
        ? `Sheet ${index + 1} ${testVariantHash(variant).toString(16)}`
        : `Sheet ${index + 1}`,
      after: null,
    })),
  });
}

function testVariantHash(value: string | undefined): number {
  if (!value) return 0;
  let variantHash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    variantHash ^= value.charCodeAt(index);
    variantHash = Math.imul(variantHash, 0x01000193);
  }
  return variantHash >>> 0;
}

export function stableHex(namespace: number, counter: number): string {
  return `${namespace.toString(16).padStart(16, "0")}${counter.toString(16).padStart(16, "0")}`;
}

export function hash(value: number): ReturnType<typeof editableArtifactStateHash> {
  return editableArtifactStateHash(`sha256:${value.toString(16).padStart(64, "0")}`);
}
