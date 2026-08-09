import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  createNativeArtifactSession,
  openNativeArtifactSession,
  type NativeArtifactSession,
  type NativeSpreadsheetSession,
} from "@opengeni/artifact-tool/native";
import type { ArtifactKernelRuntime } from "@opengeni/artifact-tool/runtime";
import {
  doctorConfiguredArtifactRuntime,
  type ConfiguredArtifactRuntimeLocation,
} from "@opengeni/artifact-tool/runtime/development";
import {
  decodeEditableArtifactCausalFrontier,
  encodeEditableArtifactCausalFrontier,
} from "@opengeni/contracts/editable-artifact-causal-frontier";
import { decodeEditableArtifactSerializedCommit } from "@opengeni/contracts/editable-artifact-serialized-commit";
import { decodeEditableArtifactMutationIntent } from "@opengeni/contracts/editable-artifacts";
import {
  MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES,
  causalFrontiersEqual,
  editableArtifactCausalFrontier,
  editableArtifactContentHash,
  editableArtifactReplicaId,
  editableArtifactStateHash,
  type ApplyAuthoritativeEditableArtifactKernelRequest,
  type ApplyAuthoritativeEditableArtifactKernelResult,
  type AuthoritativeEditableArtifactCompactionKernelPort,
  type AuthoritativeEditableArtifactCompactionKernelResult,
  type AuthoritativeEditableArtifactGenesisKernelPort,
  type AuthoritativeEditableArtifactGenesisKernelResult,
  type AuthoritativeEditableArtifactKernelPort,
  type EditableArtifactKernelState,
  type EditableArtifactSnapshotReplayPlan,
  type IsolatedEditableArtifactSnapshotKernelPort,
  type IsolatedEditableArtifactSnapshotKernelResult,
} from "@opengeni/core";
import type { BoundedObjectReadPort } from "@opengeni/storage";

const MODEL_SCHEMA_VERSION = 1;
const OPERATION_PROTOCOL_VERSION = 1;
const CRDT_STATE_VERSION = 1;
const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;

type RuntimeFacadeModule = Readonly<{
  getConfiguredArtifactRuntime?: () => unknown;
}>;

export type VerifiedNativeArtifactRuntimeBinding = Readonly<{
  runtime: ArtifactKernelRuntime;
  location: ConfiguredArtifactRuntimeLocation;
}>;

/** Loads only the manifest-pinned, byte-verified native runtime. */
export async function loadVerifiedNativeArtifactRuntime(): Promise<ArtifactKernelRuntime> {
  return (await loadVerifiedNativeArtifactRuntimeBinding()).runtime;
}

/** Same verified load plus the pinned package identity used by export profiles. */
export async function loadVerifiedNativeArtifactRuntimeBinding(): Promise<VerifiedNativeArtifactRuntimeBinding> {
  const location = await doctorConfiguredArtifactRuntime();
  const module = (await import(
    /* @vite-ignore */ pathToFileURL(location.skillFacadeEntrypoint).href
  )) as RuntimeFacadeModule;
  const candidate = module.getConfiguredArtifactRuntime?.();
  assertRuntime(candidate, location);
  return Object.freeze({ runtime: candidate, location });
}

/** Exact native authority shared by mutation, genesis, and snapshot verification. */
export class NativeEditableArtifactKernelAdapter
  implements
    AuthoritativeEditableArtifactKernelPort,
    AuthoritativeEditableArtifactGenesisKernelPort,
    AuthoritativeEditableArtifactCompactionKernelPort,
    IsolatedEditableArtifactSnapshotKernelPort
{
  constructor(
    readonly runtime: ArtifactKernelRuntime,
    private readonly objects: BoundedObjectReadPort,
  ) {
    if (runtime.kind !== "native" || runtime.target === "wasm-web") {
      throw new Error("Editable artifact authority requires a native kernel");
    }
  }

  async applyTransaction(
    request: ApplyAuthoritativeEditableArtifactKernelRequest,
  ): Promise<ApplyAuthoritativeEditableArtifactKernelResult> {
    const snapshot = request.state.snapshot;
    if (!snapshot) throw new Error("Editable artifact has no verified replay snapshot");
    const snapshotBytes = await readVerifiedSnapshot(this.objects, snapshot);
    const session = openNativeArtifactSession(this.runtime, {
      modality: request.modality,
      snapshot: snapshotBytes,
    });
    try {
      verifySnapshotBoundary(session, request.state);
      replayKernelTail(session, request.state);
      verifyDurableHead(session, request.state);
      if (request.modality === "spreadsheet") {
        if (session.modality !== "spreadsheet") throw new Error("Native modality mismatch");
        const committedTransactionBytes = session.authorTransaction(
          request.intentBytes,
          encodeEditableArtifactCausalFrontier(request.resolvedCausalBase),
        );
        return Object.freeze({
          modality: "spreadsheet" as const,
          committedTransactionBytes,
          kernelVersion: this.runtime.buildIdentity,
          modelSchemaVersion: MODEL_SCHEMA_VERSION,
        });
      }
      if (session.modality !== request.modality) {
        throw new Error("Native modality mismatch");
      }
      const nativeReceiptBytes = session.applyCommands(request.intent.commandBytes);
      return Object.freeze({
        modality: request.modality,
        nativeReceiptBytes,
        resultingStateHash: editableArtifactStateHash(session.stateHash()),
        kernelVersion: this.runtime.buildIdentity,
        modelSchemaVersion: MODEL_SCHEMA_VERSION,
      });
    } finally {
      session.dispose();
    }
  }

  async createCanonicalEmptySnapshot(input: {
    scope: Parameters<
      AuthoritativeEditableArtifactGenesisKernelPort["createCanonicalEmptySnapshot"]
    >[0]["scope"];
    artifactId: Parameters<
      AuthoritativeEditableArtifactGenesisKernelPort["createCanonicalEmptySnapshot"]
    >[0]["artifactId"];
    modality: Parameters<
      AuthoritativeEditableArtifactGenesisKernelPort["createCanonicalEmptySnapshot"]
    >[0]["modality"];
    signal?: AbortSignal;
  }): Promise<AuthoritativeEditableArtifactGenesisKernelResult> {
    throwIfAborted(input.signal);
    const session = createNativeArtifactSession(this.runtime, {
      modality: input.modality,
      replicaNamespace: namespaceForArtifact(input.artifactId),
    });
    try {
      const snapshot = session.snapshot();
      throwIfAborted(input.signal);
      const revision = safeRevision(session.revision());
      if (revision !== 0) throw new Error("Native genesis revision is not zero");
      const common = {
        scope: input.scope,
        artifactId: input.artifactId,
        modality: input.modality,
        canonicalChunks: fixedChunks(snapshot, input.signal),
        canonicalByteSize: snapshot.byteLength,
        canonicalContentHash: editableArtifactContentHash(
          `sha256:${createHash("sha256").update(snapshot).digest("hex")}`,
        ),
        stateHash: editableArtifactStateHash(session.stateHash()),
        coveredHeadSequence: 0 as const,
        modelSchemaVersion: MODEL_SCHEMA_VERSION,
        kernelVersion: this.runtime.buildIdentity,
      };
      if (session.modality === "spreadsheet") {
        return Object.freeze({
          ...common,
          modality: "spreadsheet" as const,
          coveredCausalFrontier: domainFrontier(session.frontier()),
          operationProtocolVersion: OPERATION_PROTOCOL_VERSION,
          crdtStateVersion: CRDT_STATE_VERSION,
        });
      }
      return Object.freeze({
        ...common,
        modality: session.modality,
        nativeRevision: 0 as const,
      });
    } finally {
      session.dispose();
    }
  }

  async createCanonicalSnapshot(input: {
    state: EditableArtifactKernelState;
    signal?: AbortSignal;
  }): Promise<AuthoritativeEditableArtifactCompactionKernelResult> {
    throwIfAborted(input.signal);
    const snapshot = input.state.snapshot;
    if (!snapshot) throw new Error("Editable artifact has no verified replay snapshot");
    const snapshotBytes = await readVerifiedSnapshot(this.objects, snapshot, input.signal);
    const session = openNativeArtifactSession(this.runtime, {
      modality: input.state.modality,
      snapshot: snapshotBytes,
    });
    try {
      verifySnapshotBoundary(session, input.state);
      replayKernelTail(session, input.state);
      verifyDurableHead(session, input.state);
      throwIfAborted(input.signal);
      const canonical = session.snapshot();
      const common = {
        scope: input.state.artifact.scope,
        artifactId: input.state.artifact.id,
        modality: input.state.modality,
        canonicalChunks: fixedChunks(canonical, input.signal),
        canonicalByteSize: canonical.byteLength,
        canonicalContentHash: editableArtifactContentHash(
          `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
        ),
        stateHash: editableArtifactStateHash(session.stateHash()),
        coveredHeadSequence: input.state.artifact.headSequence,
        modelSchemaVersion: MODEL_SCHEMA_VERSION,
        kernelVersion: this.runtime.buildIdentity,
      } as const;
      if (session.modality === "spreadsheet") {
        if (input.state.modality !== "spreadsheet") throw new Error("Native modality mismatch");
        return Object.freeze({
          ...common,
          modality: session.modality,
          coveredCausalFrontier: domainFrontier(session.frontier()),
          operationProtocolVersion: OPERATION_PROTOCOL_VERSION,
          crdtStateVersion: CRDT_STATE_VERSION,
        });
      }
      if (session.modality !== input.state.modality) throw new Error("Native modality mismatch");
      return Object.freeze({
        ...common,
        modality: session.modality,
        nativeRevision: safeRevision(session.revision()),
      });
    } finally {
      session.dispose();
    }
  }

  async verifyAndReconstruct(
    input: Parameters<IsolatedEditableArtifactSnapshotKernelPort["verifyAndReconstruct"]>[0],
  ): Promise<IsolatedEditableArtifactSnapshotKernelResult> {
    throwIfAborted(input.signal);
    const bytes = await collectExact(
      input.snapshotChunks,
      input.expectedSnapshotByteSize,
      input.signal,
    );
    const session = openNativeArtifactSession(this.runtime, {
      modality: input.modality,
      snapshot: bytes,
    });
    try {
      const canonical = session.snapshot();
      if (!equalBytes(canonical, bytes)) throw new Error("Native snapshot is not canonical");
      const expected = input.expectedSnapshot;
      if (expected.modality !== session.modality) throw new Error("Snapshot modality mismatch");
      const coveredHeadSequence = expected.coveredHeadSequence;
      const stateHash = editableArtifactStateHash(session.stateHash());
      if (stateHash !== expected.stateHash) throw new Error("Snapshot state hash mismatch");
      const canonicalContentHash = editableArtifactContentHash(
        `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
      );
      if (session.modality === "spreadsheet") {
        const coveredCausalFrontier = domainFrontier(session.frontier());
        if (
          expected.modality !== "spreadsheet" ||
          !causalFrontiersEqual(coveredCausalFrontier, expected.coveredCausalFrontier)
        ) {
          throw new Error("Snapshot causal coverage mismatch");
        }
        if (input.replayPlan && input.replayPlan.modality !== "spreadsheet") {
          throw new Error("Replay modality mismatch");
        }
        const replayedTarget = input.replayPlan
          ? await replaySpreadsheetPlan(session, input.replayPlan, input.signal)
          : undefined;
        return Object.freeze({
          modality: "spreadsheet" as const,
          canonicalReencodeVerified: true as const,
          scope: input.scope,
          artifactId: input.artifactId,
          canonicalByteSize: canonical.byteLength,
          canonicalContentHash,
          coveredHeadSequence,
          stateHash,
          modelSchemaVersion: MODEL_SCHEMA_VERSION,
          kernelVersion: this.runtime.buildIdentity,
          fullCrdtStateVerified: true as const,
          coveredCausalFrontier,
          operationProtocolVersion: OPERATION_PROTOCOL_VERSION,
          crdtStateVersion: CRDT_STATE_VERSION,
          ...(replayedTarget ? { replayedTarget } : {}),
        });
      }
      if (expected.modality === "spreadsheet") throw new Error("Snapshot modality mismatch");
      const nativeRevision = safeRevision(session.revision());
      if (nativeRevision !== expected.nativeRevision) {
        throw new Error("Snapshot native revision mismatch");
      }
      if (input.replayPlan && input.replayPlan.modality === "spreadsheet") {
        throw new Error("Replay modality mismatch");
      }
      const replayedTarget = input.replayPlan
        ? await replaySerializedPlan(session, input.replayPlan, input.signal)
        : undefined;
      return Object.freeze({
        modality: session.modality,
        canonicalReencodeVerified: true as const,
        scope: input.scope,
        artifactId: input.artifactId,
        canonicalByteSize: canonical.byteLength,
        canonicalContentHash,
        coveredHeadSequence,
        stateHash,
        modelSchemaVersion: MODEL_SCHEMA_VERSION,
        kernelVersion: this.runtime.buildIdentity,
        nativeRevision,
        ...(replayedTarget ? { replayedTarget } : {}),
      });
    } finally {
      session.dispose();
    }
  }
}

function assertRuntime(
  candidate: unknown,
  location: ConfiguredArtifactRuntimeLocation,
): asserts candidate is ArtifactKernelRuntime {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("Verified artifact facade returned no runtime");
  }
  const runtime = candidate as Partial<ArtifactKernelRuntime>;
  if (
    runtime.kind !== "native" ||
    runtime.target === "wasm-web" ||
    runtime.target !== location.target ||
    runtime.buildIdentity !== location.kernel.buildIdentity ||
    typeof runtime.createCollaborationSession !== "function" ||
    typeof runtime.openCollaborationSession !== "function" ||
    typeof runtime.createDocumentSession !== "function" ||
    typeof runtime.openDocumentSession !== "function" ||
    typeof runtime.createPresentationSession !== "function" ||
    typeof runtime.openPresentationSession !== "function"
  ) {
    throw new Error("Verified artifact facade returned an incompatible runtime");
  }
}

function verifySnapshotBoundary(
  session: NativeArtifactSession,
  state: EditableArtifactKernelState,
): void {
  const snapshot = state.snapshot;
  if (!snapshot || session.modality !== state.modality)
    throw new Error("Snapshot modality mismatch");
  if (session.stateHash() !== snapshot.stateHash) {
    throw new Error("Native snapshot boundary does not match durable metadata");
  }
  if (state.modality === "spreadsheet") {
    if (
      session.modality !== "spreadsheet" ||
      snapshot.modality !== "spreadsheet" ||
      !causalFrontiersEqual(domainFrontier(session.frontier()), snapshot.coveredCausalFrontier)
    ) {
      throw new Error("Native snapshot frontier does not match durable metadata");
    }
  } else if (
    session.modality === "spreadsheet" ||
    snapshot.modality === "spreadsheet" ||
    safeRevision(session.revision()) !== snapshot.nativeRevision ||
    state.baseNativeRevision !== snapshot.nativeRevision
  ) {
    throw new Error("Native snapshot revision does not match durable metadata");
  }
}

function replayKernelTail(
  session: NativeArtifactSession,
  state: EditableArtifactKernelState,
): void {
  if (state.modality === "spreadsheet") {
    if (session.modality !== "spreadsheet") throw new Error("Native modality mismatch");
    for (const transaction of state.committedTransactionTail) {
      const priorNativeRevision = safeRevision(session.revision());
      if (session.stateHash() !== transaction.priorStateHash) {
        throw new Error("Spreadsheet replay prior state mismatch");
      }
      session.applyCommitted(transaction.committedTransactionBytes);
      if (
        safeRevision(session.revision()) !== priorNativeRevision + 1 ||
        session.stateHash() !== transaction.stateHash ||
        !causalFrontiersEqual(
          domainFrontier(session.frontier()),
          transaction.resultingCausalFrontier,
        )
      ) {
        throw new Error("Spreadsheet replay result mismatch");
      }
    }
    return;
  }
  if (session.modality !== state.modality) {
    throw new Error("Native modality mismatch");
  }
  for (const transaction of state.committedTransactionTail) {
    if (
      session.stateHash() !== transaction.priorStateHash ||
      safeRevision(session.revision()) !== transaction.priorNativeRevision
    ) {
      throw new Error("Serialized replay prior state mismatch");
    }
    const commit = decodeEditableArtifactSerializedCommit(
      transaction.committedTransactionBytes,
      state.modality,
    );
    const intent = decodeEditableArtifactMutationIntent(commit.intentBytes);
    const receipt = session.applyCommands(intent.commandBytes);
    if (
      !equalBytes(receipt, commit.nativeReceiptBytes) ||
      !equalBytes(receipt, transaction.nativeReceiptBytes) ||
      safeRevision(session.revision()) !== transaction.nativeRevision ||
      session.stateHash() !== transaction.stateHash
    ) {
      throw new Error("Serialized replay result mismatch");
    }
  }
}

function verifyDurableHead(
  session: NativeArtifactSession,
  state: EditableArtifactKernelState,
): void {
  const snapshot = state.snapshot;
  if (!snapshot) throw new Error("Editable artifact has no replay snapshot");
  let durableSequence = snapshot.coveredHeadSequence;
  for (const transaction of state.committedTransactionTail) {
    if (transaction.sequenceStart !== durableSequence + 1) {
      throw new Error("Durable transaction tail contains a sequence gap");
    }
    durableSequence = transaction.sequenceEnd;
  }
  if (
    session.modality !== state.modality ||
    durableSequence !== state.artifact.headSequence ||
    session.stateHash() !== state.artifact.stateHash
  ) {
    throw new Error("Reconstructed native state does not match the durable head");
  }
  if (
    state.modality === "spreadsheet" &&
    (session.modality !== "spreadsheet" ||
      !causalFrontiersEqual(domainFrontier(session.frontier()), state.artifact.causalFrontier))
  ) {
    throw new Error("Reconstructed native frontier does not match the durable head");
  }
  if (state.modality !== "spreadsheet") {
    const expectedNativeRevision =
      state.committedTransactionTail.at(-1)?.nativeRevision ?? state.baseNativeRevision;
    if (safeRevision(session.revision()) !== expectedNativeRevision) {
      throw new Error("Reconstructed native revision does not match the serialized tail");
    }
  }
}

async function replaySpreadsheetPlan(
  session: NativeSpreadsheetSession,
  plan: Extract<EditableArtifactSnapshotReplayPlan, { modality: "spreadsheet" }>,
  signal: AbortSignal | undefined,
): Promise<
  Readonly<{
    headSequence: number;
    causalFrontier: ReturnType<typeof editableArtifactCausalFrontier>;
    stateHash: ReturnType<typeof editableArtifactStateHash>;
  }>
> {
  let sequence = plan.baseHeadSequence;
  for await (const segment of plan.segments) {
    throwIfAborted(signal);
    if (segment.sequenceStart !== sequence + 1) throw new Error("Replay sequence gap");
    if (segment.modality !== "spreadsheet") throw new Error("Replay segment modality mismatch");
    session.applyCommitted(segment.bytes);
    sequence = segment.sequenceEnd;
  }
  if (sequence !== plan.targetHeadSequence || session.stateHash() !== plan.targetStateHash) {
    throw new Error("Replay target mismatch");
  }
  const causalFrontier = domainFrontier(session.frontier());
  if (!causalFrontiersEqual(causalFrontier, plan.targetCausalFrontier)) {
    throw new Error("Replay frontier mismatch");
  }
  return Object.freeze({
    headSequence: sequence,
    causalFrontier,
    stateHash: editableArtifactStateHash(session.stateHash()),
  });
}

async function replaySerializedPlan(
  session: Exclude<NativeArtifactSession, NativeSpreadsheetSession>,
  plan: Exclude<EditableArtifactSnapshotReplayPlan, { modality: "spreadsheet" }>,
  signal: AbortSignal | undefined,
): Promise<
  Readonly<{
    headSequence: number;
    nativeRevision: number;
    stateHash: ReturnType<typeof editableArtifactStateHash>;
  }>
> {
  if (session.modality !== plan.modality) throw new Error("Replay modality mismatch");
  let sequence = plan.baseHeadSequence;
  for await (const segment of plan.segments) {
    throwIfAborted(signal);
    if (segment.sequenceStart !== sequence + 1 || segment.modality !== session.modality) {
      throw new Error("Replay sequence or modality mismatch");
    }
    const commit = decodeEditableArtifactSerializedCommit(segment.bytes, session.modality);
    const intent = decodeEditableArtifactMutationIntent(commit.intentBytes);
    const receipt = session.applyCommands(intent.commandBytes);
    if (!equalBytes(receipt, commit.nativeReceiptBytes)) throw new Error("Replay receipt mismatch");
    sequence = segment.sequenceEnd;
  }
  if (sequence !== plan.targetHeadSequence || session.stateHash() !== plan.targetStateHash) {
    throw new Error("Replay target mismatch");
  }
  if (safeRevision(session.revision()) !== plan.targetNativeRevision) {
    throw new Error("Replay native revision mismatch");
  }
  return Object.freeze({
    headSequence: sequence,
    nativeRevision: plan.targetNativeRevision,
    stateHash: editableArtifactStateHash(session.stateHash()),
  });
}

function domainFrontier(bytes: Uint8Array): ReturnType<typeof editableArtifactCausalFrontier> {
  return editableArtifactCausalFrontier(
    decodeEditableArtifactCausalFrontier(bytes).map((entry) => ({
      replicaId: editableArtifactReplicaId(entry.replicaId),
      counter: entry.counter,
    })),
  );
}

async function readVerifiedSnapshot(
  objects: BoundedObjectReadPort,
  snapshot: NonNullable<EditableArtifactKernelState["snapshot"]>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const object = await objects.open({
    opaqueReference: snapshot.blobReference,
    maxBytes: MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES,
    expectedByteSize: snapshot.byteSize,
    ...(signal ? { signal } : {}),
  });
  try {
    if (object.contentType !== undefined && object.contentType !== snapshot.mimeType) {
      throw new Error("Snapshot content type mismatch");
    }
    const bytes = await collectExact(
      object.chunks(signal ? { signal } : {}),
      snapshot.byteSize,
      signal,
    );
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (contentHash !== snapshot.contentHash) throw new Error("Snapshot content hash mismatch");
    await object.assertUnchanged(signal);
    return bytes;
  } finally {
    await object.close();
  }
}

async function collectExact(
  chunks: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new Error("Snapshot byte size is invalid");
  }
  const result = new Uint8Array(expectedBytes);
  let offset = 0;
  for await (const chunk of chunks) {
    throwIfAborted(signal);
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
      throw new Error("Snapshot stream is truncated");
    }
    if (offset + chunk.byteLength > result.byteLength) {
      throw new Error("Snapshot stream exceeds its declared size");
    }
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  throwIfAborted(signal);
  if (offset !== result.byteLength) throw new Error("Snapshot stream is truncated");
  return result;
}

async function* fixedChunks(bytes: Uint8Array, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += SNAPSHOT_CHUNK_BYTES) {
    throwIfAborted(signal);
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + SNAPSHOT_CHUNK_BYTES));
  }
}

function namespaceForArtifact(artifactId: string): bigint {
  const digest = createHash("sha256").update(artifactId).digest();
  let value = 0n;
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(digest[index]!);
  return value === 0n ? 1n : value;
}

function safeRevision(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Native revision exceeds the safe integer range");
  }
  return Number(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Editable artifact native operation was cancelled");
}
