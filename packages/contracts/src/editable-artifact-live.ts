import {
  EDITABLE_ARTIFACT_INTENT_MAX_BYTES,
  hashEditableArtifactMutationIntentBytes,
  type EditableArtifactCausalEntry,
} from "./editable-artifacts";

const MAGIC = new TextEncoder().encode("OGALV001");
const HEADER_BYTES = 20;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 4_096;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_CAUSAL_ACTORS = 1_024;
const textEncoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

const CLIENT_OPEN = 1;
const CLIENT_APPLIED = 2;
const CLIENT_MUTATION = 3;

const SERVER_OPEN = 64;
const SERVER_SNAPSHOT = 65;
const SERVER_TRANSACTION = 66;
const SERVER_BARRIER = 67;
const SERVER_WATERMARK = 68;
const SERVER_RESYNC_REQUIRED = 69;
const SERVER_APPLIED = 70;
const SERVER_AUTHORIZATION_CHANGED = 71;
const SERVER_MUTATION_ACCEPTED = 72;
const SERVER_MUTATION_REJECTED = 73;
const RESYNC_REASONS = new Set([
  "retention_gap",
  "durable_gap",
  "invalid_ack",
  "slow_client",
  "oversized_frame",
]);
const MUTATION_REJECTION_CODES = new Set([
  "invalid_request",
  "forbidden",
  "conflict",
  "unsupported",
  "unavailable",
]);

export const EDITABLE_ARTIFACT_LIVE_WIRE_VERSION = 1;

export type EditableArtifactId = string;
export type EditableArtifactRequestHash = string;
export type EditableArtifactStateHash = string;
export type EditableArtifactContentHash = string;
export type EditableArtifactTransactionId = string;
export type EditableArtifactClientTransactionId = string;
export type EditableArtifactCausalFrontier = readonly EditableArtifactCausalEntry[];
export type EditableArtifactLiveModality = "document" | "spreadsheet" | "presentation";

export type EditableArtifactLiveErrorCode =
  | "invalid_ticket"
  | "ticket_expired"
  | "ticket_replayed"
  | "protocol_mismatch"
  | "permission_changed"
  | "invalid_frame"
  | "oversized_frame"
  | "stale_epoch"
  | "invalid_ack"
  | "durable_gap"
  | "retention_gap"
  | "slow_client"
  | "closed";

/** Shared transport error: core and SDK must classify the same frame identically. */
export class EditableArtifactLiveError extends Error {
  constructor(
    readonly code: EditableArtifactLiveErrorCode,
    message: string,
    readonly options: Readonly<{
      retryable?: boolean;
      requiresSnapshot?: boolean;
      cause?: unknown;
    }> = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EditableArtifactLiveError";
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }

  get requiresSnapshot(): boolean {
    return this.options.requiresSnapshot ?? false;
  }
}

type EditableArtifactLiveResumeCommon = Readonly<{
  localCursor: number | null;
  localStateHash: EditableArtifactStateHash | null;
  requireSnapshot: boolean;
}>;

export type EditableArtifactLiveResume =
  | (EditableArtifactLiveResumeCommon &
      Readonly<{
        /** Omitted on OGALV001 for byte-compatible spreadsheet sessions. */
        modality?: "spreadsheet";
        localCausalFrontier: EditableArtifactCausalFrontier;
      }>)
  | (EditableArtifactLiveResumeCommon &
      Readonly<{
        modality: "document" | "presentation";
        localNativeRevision: number | null;
      }>);

export type EditableArtifactLiveTicket = Readonly<{
  artifactId: EditableArtifactId;
  modality: EditableArtifactLiveModality;
  replicaId: string;
  token: string;
  expiresAt: string;
  protocolVersion: number;
}>;

type EditableArtifactLiveSnapshotCommon = Readonly<{
  artifactId: EditableArtifactId;
  sequence: number;
  stateHash: EditableArtifactStateHash;
  digest: EditableArtifactContentHash;
  kernelVersion: string;
  modelSchemaVersion: number;
  bytes: Uint8Array;
}>;

export type EditableArtifactLiveSnapshot =
  | (EditableArtifactLiveSnapshotCommon &
      Readonly<{
        modality?: "spreadsheet";
        causalFrontier: EditableArtifactCausalFrontier;
        protocolVersion: number;
      }>)
  | (EditableArtifactLiveSnapshotCommon &
      Readonly<{
        modality: "document" | "presentation";
        nativeRevision: number;
      }>);

type EditableArtifactLiveCommittedTransactionCommon = Readonly<{
  artifactId: EditableArtifactId;
  transactionId: EditableArtifactTransactionId;
  requestHash: EditableArtifactRequestHash;
  startSequence: number;
  endSequence: number;
  priorStateHash: EditableArtifactStateHash;
  stateHash: EditableArtifactStateHash;
  committedTransactionBytes: Uint8Array;
}>;

export type EditableArtifactLiveCommittedTransaction =
  | (EditableArtifactLiveCommittedTransactionCommon &
      Readonly<{
        modality?: "spreadsheet";
        causalFrontier: EditableArtifactCausalFrontier;
        protocolVersion: number;
        /** Exact canonical whole OGACO transaction envelope. */
        committedTransactionBytes: Uint8Array;
      }>)
  | (EditableArtifactLiveCommittedTransactionCommon &
      Readonly<{
        modality: "document" | "presentation";
        priorNativeRevision: number;
        nativeRevision: number;
        commitProtocolVersion: number;
        /** Exact canonical whole OGAST transaction envelope. */
        committedTransactionBytes: Uint8Array;
      }>);

type EditableArtifactLiveHeadCommon = Readonly<{
  headSequence: number;
  stateHash: EditableArtifactStateHash;
  minimumReplaySequence: number;
}>;

export type EditableArtifactLiveHead =
  | (EditableArtifactLiveHeadCommon &
      Readonly<{
        modality: "spreadsheet";
        causalFrontier: EditableArtifactCausalFrontier;
      }>)
  | (EditableArtifactLiveHeadCommon &
      Readonly<{
        modality: "document" | "presentation";
        nativeRevision: number;
      }>);

export type EditableArtifactLiveBootstrap = EditableArtifactLiveHead &
  Readonly<{
    resumeAccepted: boolean;
    resumeSequence: number;
    resumeStateHash: EditableArtifactStateHash;
    snapshot: EditableArtifactLiveSnapshot | null;
  }>;

export type EditableArtifactLiveAppliedClientFrame = Readonly<{
  type: "applied";
  protocolVersion: number;
  artifactId: EditableArtifactId;
  streamEpoch: string;
  sequence: number;
  stateHash: EditableArtifactStateHash;
}>;

export type EditableArtifactLiveMutationClientFrame = Readonly<{
  protocolVersion: number;
  artifactId: EditableArtifactId;
  streamEpoch: string;
  requestHash: EditableArtifactRequestHash;
  /** Exact bounded OGATX001 client-intent envelope, never canonical operations. */
  intentBytes: Uint8Array;
}>;

export type EditableArtifactLiveClientFrame = EditableArtifactLiveAppliedClientFrame;

export type EditableArtifactLiveCloseReason =
  | "closed"
  | "ticket_expired"
  | "ticket_replayed"
  | "protocol_mismatch"
  | "permission_changed"
  | "invalid_frame"
  | "oversized_frame"
  | "stale_epoch"
  | "invalid_ack"
  | "retention_gap"
  | "durable_gap"
  | "slow_client"
  | "transport_error";

export type EditableArtifactLiveClose = Readonly<{
  reason: EditableArtifactLiveCloseReason;
  retryable: boolean;
  requiresSnapshot: boolean;
}>;

export type EditableArtifactLiveMutationReceipt = Readonly<{
  clientTransactionId: EditableArtifactClientTransactionId;
  requestHash: EditableArtifactRequestHash;
  transaction: EditableArtifactLiveCommittedTransaction;
}>;

export type EditableArtifactLiveServerFrame =
  | Readonly<{
      type: "open";
      protocolVersion: number;
      artifactId: EditableArtifactId;
      streamEpoch: string;
      /** Omitted on the wire for spreadsheet compatibility. */
      modality?: EditableArtifactLiveModality;
      writable: boolean;
      headSequence: number;
      minimumReplaySequence: number;
      maxClientFrameBytes: number;
      maxCommandBytes: number;
      maxIntentBytes: number;
      maxCommittedTransactionBytes: number;
      maxSnapshotBytes: number;
      maxInFlightTransactions: number;
      maxInFlightBytes: number;
    }>
  | (Readonly<{
      type: "snapshot";
      protocolVersion: number;
      artifactId: EditableArtifactId;
      streamEpoch: string;
      sequence: number;
      stateHash: EditableArtifactStateHash;
      digest: EditableArtifactContentHash;
      kernelVersion: string;
      modelSchemaVersion: number;
      offset: number;
      totalBytes: number;
      final: boolean;
      bytes: Uint8Array;
    }> &
      (
        | Readonly<{
            /** Omitted on the wire for spreadsheet compatibility. */
            modality?: "spreadsheet";
            causalFrontier: EditableArtifactCausalFrontier;
          }>
        | Readonly<{
            modality: "document" | "presentation";
            nativeRevision: number;
          }>
      ))
  | Readonly<{
      type: "transaction";
      protocolVersion: number;
      artifactId: EditableArtifactId;
      streamEpoch: string;
      transaction: EditableArtifactLiveCommittedTransaction;
    }>
  | Readonly<{
      type: "barrier";
      protocolVersion: number;
      artifactId: EditableArtifactId;
      streamEpoch: string;
      sequence: number;
      stateHash: EditableArtifactStateHash;
    }>
  | Readonly<{
      type: "watermark";
      protocolVersion: number;
      artifactId: EditableArtifactId;
      streamEpoch: string;
      headSequence: number;
    }>
  | Readonly<{
      type: "resyncRequired";
      protocolVersion: number;
      artifactId: EditableArtifactId;
      streamEpoch: string;
      reason: "retention_gap" | "durable_gap" | "invalid_ack" | "slow_client" | "oversized_frame";
      headSequence: number;
    }>
  | Readonly<{
      type: "applied";
      protocolVersion: number;
      artifactId: EditableArtifactId;
      streamEpoch: string;
      sequence: number;
      stateHash: EditableArtifactStateHash;
    }>
  | Readonly<{
      type: "authorizationChanged";
      protocolVersion: number;
      artifactId: EditableArtifactId;
      streamEpoch: string;
      writable: boolean;
    }>
  | Readonly<{
      type: "mutationAccepted";
      protocolVersion: number;
      artifactId: EditableArtifactId;
      streamEpoch: string;
      requestHash: EditableArtifactRequestHash;
      clientTransactionId: EditableArtifactClientTransactionId;
      transactionId: EditableArtifactTransactionId;
      startSequence: number;
      endSequence: number;
      stateHash: EditableArtifactStateHash;
    }>
  | Readonly<{
      type: "mutationRejected";
      protocolVersion: number;
      artifactId: EditableArtifactId;
      streamEpoch: string;
      requestHash: EditableArtifactRequestHash;
      code: "invalid_request" | "forbidden" | "conflict" | "unsupported" | "unavailable";
      retryable: boolean;
    }>;

export type EditableArtifactLiveOpenWireFrame = Readonly<{
  type: "open";
  protocolVersion: number;
  artifactId: EditableArtifactId;
  token: string;
  resume: EditableArtifactLiveResume;
}>;

export type EditableArtifactLiveAppliedWireFrame = Readonly<{
  type: "applied";
  protocolVersion: number;
  artifactId: EditableArtifactId;
  streamEpoch: string;
  sequence: number;
  stateHash: EditableArtifactStateHash;
}>;

export type EditableArtifactLiveMutationWireFrame = Readonly<{
  type: "mutation";
  protocolVersion: number;
  artifactId: EditableArtifactId;
  streamEpoch: string;
  requestHash: EditableArtifactRequestHash;
  /** Exact OGATX001 bytes. No client-authored operation/state projection exists. */
  intentBytes: Uint8Array;
}>;

export type EditableArtifactLiveClientWireFrame =
  | EditableArtifactLiveOpenWireFrame
  | EditableArtifactLiveAppliedWireFrame
  | EditableArtifactLiveMutationWireFrame;

/**
 * One bounded binary WebSocket envelope. Metadata is strict canonical JSON;
 * snapshots, OGATX intents, and committed OGACO transactions remain opaque
 * binary payloads and are never base64-encoded or reserialized by transport.
 */
export function decodeEditableArtifactLiveClientWireFrame(
  bytes: Uint8Array,
): EditableArtifactLiveClientWireFrame {
  const decoded = decodeEnvelope(bytes);
  if (decoded.kind === CLIENT_OPEN) return decodeOpen(decoded.metadata, decoded.payload);
  if (decoded.kind === CLIENT_APPLIED) return decodeApplied(decoded.metadata, decoded.payload);
  if (decoded.kind === CLIENT_MUTATION) return decodeMutation(decoded.metadata, decoded.payload);
  throw invalidFrame("Unknown editable artifact client frame kind");
}

export function encodeEditableArtifactLiveOpenWireFrame(
  frame: EditableArtifactLiveOpenWireFrame,
): Uint8Array {
  const artifactId = editableArtifactId(frame.artifactId);
  const protocolVersion = positiveInteger(frame.protocolVersion, "protocolVersion");
  const token = boundedToken(frame.token);
  const resume = normalizeResume(frame.resume);
  if (resume.modality === "document" || resume.modality === "presentation") {
    return encodeEnvelope(
      CLIENT_OPEN,
      {
        type: "open",
        protocolVersion,
        artifactId,
        token,
        modality: resume.modality,
        localCursor: resume.localCursor,
        localStateHash: resume.localStateHash,
        localNativeRevision: resume.localNativeRevision,
        requireSnapshot: resume.requireSnapshot,
      },
      EMPTY_BYTES,
    );
  }
  if (!("localCausalFrontier" in resume)) {
    throw invalidFrame("spreadsheet resume requires a causal frontier");
  }
  return encodeEnvelope(
    CLIENT_OPEN,
    {
      type: "open",
      protocolVersion,
      artifactId,
      token,
      localCursor: resume.localCursor,
      localStateHash: resume.localStateHash,
      localCausalFrontier: resume.localCausalFrontier,
      requireSnapshot: resume.requireSnapshot,
    },
    EMPTY_BYTES,
  );
}

export function encodeEditableArtifactLiveAppliedWireFrame(
  frame: EditableArtifactLiveAppliedWireFrame,
): Uint8Array {
  return encodeEnvelope(
    CLIENT_APPLIED,
    {
      type: "applied",
      protocolVersion: positiveInteger(frame.protocolVersion, "protocolVersion"),
      artifactId: editableArtifactId(frame.artifactId),
      streamEpoch: boundedString(frame.streamEpoch, "streamEpoch", MAX_IDENTIFIER_BYTES),
      sequence: nonnegativeInteger(frame.sequence, "sequence"),
      stateHash: editableArtifactStateHash(frame.stateHash),
    },
    EMPTY_BYTES,
  );
}

export function encodeEditableArtifactLiveMutationWireFrame(
  frame: EditableArtifactLiveMutationWireFrame,
): Uint8Array {
  const intentBytes = ownPayload(frame.intentBytes, EDITABLE_ARTIFACT_INTENT_MAX_BYTES, false);
  const requestHash = editableArtifactRequestHash(frame.requestHash);
  if (hashEditableArtifactMutationIntentBytes(intentBytes) !== requestHash) {
    throw invalidFrame("Mutation request hash does not match exact OGATX bytes");
  }
  return encodeEnvelope(
    CLIENT_MUTATION,
    {
      type: "mutation",
      protocolVersion: positiveInteger(frame.protocolVersion, "protocolVersion"),
      artifactId: editableArtifactId(frame.artifactId),
      streamEpoch: boundedString(frame.streamEpoch, "streamEpoch", MAX_IDENTIFIER_BYTES),
      requestHash,
    },
    intentBytes,
  );
}

export function encodeEditableArtifactLiveServerWireFrame(
  frame: EditableArtifactLiveServerFrame,
): Uint8Array {
  switch (frame.type) {
    case "open": {
      const { modality, ...metadata } = frame;
      return encodeEnvelope(
        SERVER_OPEN,
        modality === "document" || modality === "presentation"
          ? {
              type: metadata.type,
              protocolVersion: metadata.protocolVersion,
              artifactId: metadata.artifactId,
              streamEpoch: metadata.streamEpoch,
              modality,
              writable: metadata.writable,
              headSequence: metadata.headSequence,
              minimumReplaySequence: metadata.minimumReplaySequence,
              maxClientFrameBytes: metadata.maxClientFrameBytes,
              maxCommandBytes: metadata.maxCommandBytes,
              maxIntentBytes: metadata.maxIntentBytes,
              maxCommittedTransactionBytes: metadata.maxCommittedTransactionBytes,
              maxSnapshotBytes: metadata.maxSnapshotBytes,
              maxInFlightTransactions: metadata.maxInFlightTransactions,
              maxInFlightBytes: metadata.maxInFlightBytes,
            }
          : metadata,
        EMPTY_BYTES,
      );
    }
    case "snapshot": {
      const { bytes, modality, ...metadata } = frame;
      if (
        (modality === "document" || modality === "presentation") &&
        !("nativeRevision" in metadata)
      ) {
        throw invalidFrame("serialized snapshot requires a native revision");
      }
      if (
        modality !== "document" &&
        modality !== "presentation" &&
        !("causalFrontier" in metadata)
      ) {
        throw invalidFrame("spreadsheet snapshot requires a causal frontier");
      }
      return encodeEnvelope(
        SERVER_SNAPSHOT,
        modality === "document" || modality === "presentation"
          ? {
              type: metadata.type,
              protocolVersion: metadata.protocolVersion,
              artifactId: metadata.artifactId,
              streamEpoch: metadata.streamEpoch,
              modality,
              sequence: metadata.sequence,
              stateHash: metadata.stateHash,
              nativeRevision: (metadata as { nativeRevision: number }).nativeRevision,
              digest: metadata.digest,
              kernelVersion: metadata.kernelVersion,
              modelSchemaVersion: metadata.modelSchemaVersion,
              offset: metadata.offset,
              totalBytes: metadata.totalBytes,
              final: metadata.final,
            }
          : {
              type: metadata.type,
              protocolVersion: metadata.protocolVersion,
              artifactId: metadata.artifactId,
              streamEpoch: metadata.streamEpoch,
              sequence: metadata.sequence,
              stateHash: metadata.stateHash,
              causalFrontier: (metadata as { causalFrontier: EditableArtifactCausalFrontier })
                .causalFrontier,
              digest: metadata.digest,
              kernelVersion: metadata.kernelVersion,
              modelSchemaVersion: metadata.modelSchemaVersion,
              offset: metadata.offset,
              totalBytes: metadata.totalBytes,
              final: metadata.final,
            },
        bytes,
      );
    }
    case "transaction": {
      const { committedTransactionBytes, ...transaction } = frame.transaction;
      const serializedTransaction = transaction as Extract<
        EditableArtifactLiveCommittedTransaction,
        { modality: "document" | "presentation" }
      >;
      const transactionMetadata =
        transaction.modality === undefined || transaction.modality === "spreadsheet"
          ? {
              artifactId: transaction.artifactId,
              transactionId: transaction.transactionId,
              requestHash: transaction.requestHash,
              startSequence: transaction.startSequence,
              endSequence: transaction.endSequence,
              priorStateHash: transaction.priorStateHash,
              stateHash: transaction.stateHash,
              causalFrontier: transaction.causalFrontier,
              protocolVersion: transaction.protocolVersion,
            }
          : {
              artifactId: serializedTransaction.artifactId,
              modality: serializedTransaction.modality,
              transactionId: serializedTransaction.transactionId,
              requestHash: serializedTransaction.requestHash,
              startSequence: serializedTransaction.startSequence,
              endSequence: serializedTransaction.endSequence,
              priorStateHash: serializedTransaction.priorStateHash,
              stateHash: serializedTransaction.stateHash,
              priorNativeRevision: serializedTransaction.priorNativeRevision,
              nativeRevision: serializedTransaction.nativeRevision,
              commitProtocolVersion: serializedTransaction.commitProtocolVersion,
            };
      return encodeEnvelope(
        SERVER_TRANSACTION,
        { ...frame, transaction: transactionMetadata },
        committedTransactionBytes,
      );
    }
    case "barrier":
      return encodeEnvelope(SERVER_BARRIER, { ...frame }, EMPTY_BYTES);
    case "watermark":
      return encodeEnvelope(SERVER_WATERMARK, { ...frame }, EMPTY_BYTES);
    case "resyncRequired":
      return encodeEnvelope(SERVER_RESYNC_REQUIRED, { ...frame }, EMPTY_BYTES);
    case "applied":
      return encodeEnvelope(SERVER_APPLIED, { ...frame }, EMPTY_BYTES);
    case "authorizationChanged":
      return encodeEnvelope(SERVER_AUTHORIZATION_CHANGED, { ...frame }, EMPTY_BYTES);
    case "mutationAccepted":
      return encodeEnvelope(SERVER_MUTATION_ACCEPTED, { ...frame }, EMPTY_BYTES);
    case "mutationRejected":
      return encodeEnvelope(SERVER_MUTATION_REJECTED, { ...frame }, EMPTY_BYTES);
  }
}

/** Strict inverse used by browser/desktop SDK transports. */
export function decodeEditableArtifactLiveServerWireFrame(
  bytes: Uint8Array,
): EditableArtifactLiveServerFrame {
  const decoded = decodeEnvelope(bytes);
  const metadata = decoded.metadata;
  switch (decoded.kind) {
    case SERVER_OPEN: {
      requireNoPayload(decoded.payload);
      const modality = serverModality(metadata);
      requireServerKeys(metadata, "open", [
        ...(modality === "spreadsheet" ? [] : ["modality"]),
        "writable",
        "headSequence",
        "minimumReplaySequence",
        "maxClientFrameBytes",
        "maxCommandBytes",
        "maxIntentBytes",
        "maxCommittedTransactionBytes",
        "maxSnapshotBytes",
        "maxInFlightTransactions",
        "maxInFlightBytes",
      ]);
      const common = {
        ...serverIdentity(metadata, "open"),
        writable: requiredBoolean(metadata.writable, "writable"),
        headSequence: nonnegativeInteger(metadata.headSequence, "headSequence"),
        minimumReplaySequence: nonnegativeInteger(
          metadata.minimumReplaySequence,
          "minimumReplaySequence",
        ),
        maxClientFrameBytes: positiveInteger(metadata.maxClientFrameBytes, "maxClientFrameBytes"),
        maxCommandBytes: nonnegativeInteger(metadata.maxCommandBytes, "maxCommandBytes"),
        maxIntentBytes: nonnegativeInteger(metadata.maxIntentBytes, "maxIntentBytes"),
        maxCommittedTransactionBytes: nonnegativeInteger(
          metadata.maxCommittedTransactionBytes,
          "maxCommittedTransactionBytes",
        ),
        maxSnapshotBytes: positiveInteger(metadata.maxSnapshotBytes, "maxSnapshotBytes"),
        maxInFlightTransactions: positiveInteger(
          metadata.maxInFlightTransactions,
          "maxInFlightTransactions",
        ),
        maxInFlightBytes: positiveInteger(metadata.maxInFlightBytes, "maxInFlightBytes"),
      } as const;
      return Object.freeze(modality === "spreadsheet" ? common : { ...common, modality });
    }
    case SERVER_SNAPSHOT: {
      const modality = serverModality(metadata);
      requireServerKeys(metadata, "snapshot", [
        ...(modality === "spreadsheet" ? [] : ["modality"]),
        "sequence",
        "stateHash",
        modality === "spreadsheet" ? "causalFrontier" : "nativeRevision",
        "digest",
        "kernelVersion",
        "modelSchemaVersion",
        "offset",
        "totalBytes",
        "final",
      ]);
      const offset = nonnegativeInteger(metadata.offset, "offset");
      const totalBytes = positiveInteger(metadata.totalBytes, "totalBytes");
      const final = requiredBoolean(metadata.final, "final");
      if (decoded.payload.byteLength === 0 || offset + decoded.payload.byteLength > totalBytes) {
        throw invalidFrame("snapshot chunk bounds are invalid");
      }
      if (final !== (offset + decoded.payload.byteLength === totalBytes)) {
        throw invalidFrame("snapshot final flag does not match its byte boundary");
      }
      const common = {
        ...serverIdentity(metadata, "snapshot"),
        sequence: nonnegativeInteger(metadata.sequence, "sequence"),
        stateHash: editableArtifactStateHash(requiredString(metadata.stateHash, "stateHash")),
        digest: editableArtifactContentHash(requiredString(metadata.digest, "digest")),
        kernelVersion: boundedString(
          requiredString(metadata.kernelVersion, "kernelVersion"),
          "kernelVersion",
          MAX_IDENTIFIER_BYTES,
        ),
        modelSchemaVersion: positiveInteger(metadata.modelSchemaVersion, "modelSchemaVersion"),
        offset,
        totalBytes,
        final,
        bytes: decoded.payload,
      } as const;
      return Object.freeze(
        modality === "spreadsheet"
          ? {
              ...common,
              causalFrontier: requiredFrontier(metadata.causalFrontier),
            }
          : {
              ...common,
              modality,
              nativeRevision: nonnegativeInteger(metadata.nativeRevision, "nativeRevision"),
            },
      );
    }
    case SERVER_TRANSACTION: {
      requireServerKeys(metadata, "transaction", ["transaction"]);
      const transaction = requiredRecord(metadata.transaction, "transaction");
      const modality = transactionModality(transaction);
      requireExactKeys(
        transaction,
        modality === "spreadsheet"
          ? [
              "artifactId",
              "transactionId",
              "requestHash",
              "startSequence",
              "endSequence",
              "priorStateHash",
              "stateHash",
              "causalFrontier",
              "protocolVersion",
            ]
          : [
              "artifactId",
              "modality",
              "transactionId",
              "requestHash",
              "startSequence",
              "endSequence",
              "priorStateHash",
              "stateHash",
              "priorNativeRevision",
              "nativeRevision",
              "commitProtocolVersion",
            ],
      );
      if (decoded.payload.byteLength === 0) {
        throw invalidFrame("transaction payload must not be empty");
      }
      const startSequence = positiveInteger(transaction.startSequence, "startSequence");
      const endSequence = positiveInteger(transaction.endSequence, "endSequence");
      if (endSequence < startSequence)
        throw invalidFrame("transaction sequence interval is inverted");
      const common = {
        ...serverIdentity(metadata, "transaction"),
        transaction: {
          artifactId: editableArtifactId(requiredString(transaction.artifactId, "artifactId")),
          transactionId: editableArtifactTransactionId(
            requiredString(transaction.transactionId, "transactionId"),
          ),
          requestHash: editableArtifactRequestHash(
            requiredString(transaction.requestHash, "requestHash"),
          ),
          startSequence,
          endSequence,
          priorStateHash: editableArtifactStateHash(
            requiredString(transaction.priorStateHash, "priorStateHash"),
          ),
          stateHash: editableArtifactStateHash(requiredString(transaction.stateHash, "stateHash")),
          committedTransactionBytes: decoded.payload,
        },
      } as const;
      return Object.freeze({
        ...common,
        transaction: Object.freeze(
          modality === "spreadsheet"
            ? {
                ...common.transaction,
                causalFrontier: requiredFrontier(transaction.causalFrontier),
                protocolVersion: positiveInteger(transaction.protocolVersion, "protocolVersion"),
              }
            : {
                ...common.transaction,
                modality,
                priorNativeRevision: nonnegativeInteger(
                  transaction.priorNativeRevision,
                  "priorNativeRevision",
                ),
                nativeRevision: nonnegativeInteger(transaction.nativeRevision, "nativeRevision"),
                commitProtocolVersion: positiveInteger(
                  transaction.commitProtocolVersion,
                  "commitProtocolVersion",
                ),
              },
        ),
      });
    }
    case SERVER_BARRIER:
    case SERVER_APPLIED: {
      const type = decoded.kind === SERVER_BARRIER ? "barrier" : "applied";
      requireNoPayload(decoded.payload);
      requireServerKeys(metadata, type, ["sequence", "stateHash"]);
      return Object.freeze({
        ...serverIdentity(metadata, type),
        sequence: nonnegativeInteger(metadata.sequence, "sequence"),
        stateHash: editableArtifactStateHash(requiredString(metadata.stateHash, "stateHash")),
      });
    }
    case SERVER_WATERMARK: {
      requireNoPayload(decoded.payload);
      requireServerKeys(metadata, "watermark", ["headSequence"]);
      return Object.freeze({
        ...serverIdentity(metadata, "watermark"),
        headSequence: nonnegativeInteger(metadata.headSequence, "headSequence"),
      });
    }
    case SERVER_RESYNC_REQUIRED: {
      requireNoPayload(decoded.payload);
      requireServerKeys(metadata, "resyncRequired", ["reason", "headSequence"]);
      const reason = requiredString(metadata.reason, "reason");
      if (!RESYNC_REASONS.has(reason)) throw invalidFrame("resync reason is invalid");
      return Object.freeze({
        ...serverIdentity(metadata, "resyncRequired"),
        reason: reason as Extract<
          EditableArtifactLiveServerFrame,
          { type: "resyncRequired" }
        >["reason"],
        headSequence: nonnegativeInteger(metadata.headSequence, "headSequence"),
      });
    }
    case SERVER_AUTHORIZATION_CHANGED: {
      requireNoPayload(decoded.payload);
      requireServerKeys(metadata, "authorizationChanged", ["writable"]);
      return Object.freeze({
        ...serverIdentity(metadata, "authorizationChanged"),
        writable: requiredBoolean(metadata.writable, "writable"),
      });
    }
    case SERVER_MUTATION_ACCEPTED: {
      requireNoPayload(decoded.payload);
      requireServerKeys(metadata, "mutationAccepted", [
        "requestHash",
        "clientTransactionId",
        "transactionId",
        "startSequence",
        "endSequence",
        "stateHash",
      ]);
      const startSequence = positiveInteger(metadata.startSequence, "startSequence");
      const endSequence = positiveInteger(metadata.endSequence, "endSequence");
      if (endSequence < startSequence) throw invalidFrame("accepted sequence interval is inverted");
      return Object.freeze({
        ...serverIdentity(metadata, "mutationAccepted"),
        requestHash: editableArtifactRequestHash(
          requiredString(metadata.requestHash, "requestHash"),
        ),
        clientTransactionId: editableArtifactClientTransactionId(
          requiredString(metadata.clientTransactionId, "clientTransactionId"),
        ),
        transactionId: editableArtifactTransactionId(
          requiredString(metadata.transactionId, "transactionId"),
        ),
        startSequence,
        endSequence,
        stateHash: editableArtifactStateHash(requiredString(metadata.stateHash, "stateHash")),
      });
    }
    case SERVER_MUTATION_REJECTED: {
      requireNoPayload(decoded.payload);
      requireServerKeys(metadata, "mutationRejected", ["requestHash", "code", "retryable"]);
      const code = requiredString(metadata.code, "code");
      if (!MUTATION_REJECTION_CODES.has(code)) {
        throw invalidFrame("mutation rejection code is invalid");
      }
      return Object.freeze({
        ...serverIdentity(metadata, "mutationRejected"),
        requestHash: editableArtifactRequestHash(
          requiredString(metadata.requestHash, "requestHash"),
        ),
        code: code as Extract<
          EditableArtifactLiveServerFrame,
          { type: "mutationRejected" }
        >["code"],
        retryable: requiredBoolean(metadata.retryable, "retryable"),
      });
    }
    default:
      throw invalidFrame("Unknown editable artifact server frame kind");
  }
}

/** Header-level inspection for transport tests and SDK adapters. */
export function inspectEditableArtifactLiveWireEnvelope(bytes: Uint8Array): Readonly<{
  kind: number;
  metadata: Readonly<Record<string, unknown>>;
  payload: Uint8Array;
}> {
  return decodeEnvelope(bytes);
}

function decodeOpen(
  metadata: Readonly<Record<string, unknown>>,
  payload: Uint8Array,
): EditableArtifactLiveOpenWireFrame {
  requireNoPayload(payload);
  const modality = clientOpenModality(metadata);
  requireExactKeys(
    metadata,
    modality === "spreadsheet"
      ? [
          "type",
          "protocolVersion",
          "artifactId",
          "token",
          "localCursor",
          "localStateHash",
          "localCausalFrontier",
          "requireSnapshot",
        ]
      : [
          "type",
          "protocolVersion",
          "artifactId",
          "token",
          "modality",
          "localCursor",
          "localStateHash",
          "localNativeRevision",
          "requireSnapshot",
        ],
  );
  requireLiteral(metadata.type, "open", "type");
  return Object.freeze({
    type: "open",
    protocolVersion: positiveInteger(metadata.protocolVersion, "protocolVersion"),
    artifactId: editableArtifactId(requiredString(metadata.artifactId, "artifactId")),
    token: boundedToken(requiredString(metadata.token, "token")),
    resume: normalizeResume(
      modality === "spreadsheet"
        ? {
            modality,
            localCursor: nullableNonnegativeInteger(metadata.localCursor, "localCursor"),
            localStateHash:
              metadata.localStateHash === null
                ? null
                : editableArtifactStateHash(
                    requiredString(metadata.localStateHash, "localStateHash"),
                  ),
            localCausalFrontier: requiredFrontier(metadata.localCausalFrontier),
            requireSnapshot: requiredBoolean(metadata.requireSnapshot, "requireSnapshot"),
          }
        : {
            modality,
            localCursor: nullableNonnegativeInteger(metadata.localCursor, "localCursor"),
            localStateHash:
              metadata.localStateHash === null
                ? null
                : editableArtifactStateHash(
                    requiredString(metadata.localStateHash, "localStateHash"),
                  ),
            localNativeRevision: nullableNonnegativeInteger(
              metadata.localNativeRevision,
              "localNativeRevision",
            ),
            requireSnapshot: requiredBoolean(metadata.requireSnapshot, "requireSnapshot"),
          },
    ),
  });
}

function decodeApplied(
  metadata: Readonly<Record<string, unknown>>,
  payload: Uint8Array,
): EditableArtifactLiveAppliedWireFrame {
  requireNoPayload(payload);
  requireExactKeys(metadata, [
    "type",
    "protocolVersion",
    "artifactId",
    "streamEpoch",
    "sequence",
    "stateHash",
  ]);
  requireLiteral(metadata.type, "applied", "type");
  return Object.freeze({
    type: "applied",
    protocolVersion: positiveInteger(metadata.protocolVersion, "protocolVersion"),
    artifactId: editableArtifactId(requiredString(metadata.artifactId, "artifactId")),
    streamEpoch: boundedString(
      requiredString(metadata.streamEpoch, "streamEpoch"),
      "streamEpoch",
      MAX_IDENTIFIER_BYTES,
    ),
    sequence: nonnegativeInteger(metadata.sequence, "sequence"),
    stateHash: editableArtifactStateHash(requiredString(metadata.stateHash, "stateHash")),
  });
}

function decodeMutation(
  metadata: Readonly<Record<string, unknown>>,
  payload: Uint8Array,
): EditableArtifactLiveMutationWireFrame {
  requireExactKeys(metadata, [
    "type",
    "protocolVersion",
    "artifactId",
    "streamEpoch",
    "requestHash",
  ]);
  requireLiteral(metadata.type, "mutation", "type");
  const requestHash = editableArtifactRequestHash(
    requiredString(metadata.requestHash, "requestHash"),
  );
  const intentBytes = ownPayload(payload, EDITABLE_ARTIFACT_INTENT_MAX_BYTES, false);
  try {
    if (hashEditableArtifactMutationIntentBytes(intentBytes) !== requestHash) {
      throw new TypeError("request hash mismatch");
    }
  } catch (cause) {
    throw invalidFrame("Mutation request hash does not match exact OGATX bytes", cause);
  }
  return Object.freeze({
    type: "mutation",
    protocolVersion: positiveInteger(metadata.protocolVersion, "protocolVersion"),
    artifactId: editableArtifactId(requiredString(metadata.artifactId, "artifactId")),
    streamEpoch: boundedString(
      requiredString(metadata.streamEpoch, "streamEpoch"),
      "streamEpoch",
      MAX_IDENTIFIER_BYTES,
    ),
    requestHash,
    intentBytes,
  });
}

function encodeEnvelope(
  kind: number,
  metadata: Readonly<Record<string, unknown>>,
  rawPayload: Uint8Array,
): Uint8Array {
  if (!Number.isInteger(kind) || kind < 1 || kind > 255) throw new TypeError("wire kind invalid");
  const metadataBytes = textEncoder.encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength < 2 || metadataBytes.byteLength > MAX_METADATA_BYTES) {
    throw new RangeError("Editable artifact wire metadata exceeds bound");
  }
  const payload = ownPayload(rawPayload, 128 * 1024 * 1024, true);
  const total = HEADER_BYTES + metadataBytes.byteLength + payload.byteLength;
  if (!Number.isSafeInteger(total)) throw new RangeError("Editable artifact wire frame too large");
  const output = new Uint8Array(total);
  output.set(MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint8(8, EDITABLE_ARTIFACT_LIVE_WIRE_VERSION);
  view.setUint8(9, kind);
  view.setUint16(10, 0, true);
  view.setUint32(12, metadataBytes.byteLength, true);
  view.setUint32(16, payload.byteLength, true);
  output.set(metadataBytes, HEADER_BYTES);
  output.set(payload, HEADER_BYTES + metadataBytes.byteLength);
  return output;
}

function decodeEnvelope(bytes: Uint8Array): Readonly<{
  kind: number;
  metadata: Readonly<Record<string, unknown>>;
  payload: Uint8Array;
}> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_BYTES) {
    throw invalidFrame("Editable artifact wire frame is truncated");
  }
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (bytes[index] !== MAGIC[index]) throw invalidFrame("Editable artifact wire magic mismatch");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(8) !== EDITABLE_ARTIFACT_LIVE_WIRE_VERSION) {
    throw new EditableArtifactLiveError("protocol_mismatch", "Live wire version unsupported");
  }
  const kind = view.getUint8(9);
  if (view.getUint16(10, true) !== 0) throw invalidFrame("Editable artifact wire flags invalid");
  const metadataLength = view.getUint32(12, true);
  const payloadLength = view.getUint32(16, true);
  if (metadataLength < 2 || metadataLength > MAX_METADATA_BYTES) {
    throw invalidFrame("Editable artifact wire metadata exceeds bound");
  }
  const expected = HEADER_BYTES + metadataLength + payloadLength;
  if (expected !== bytes.byteLength) throw invalidFrame("Editable artifact wire length mismatch");
  const metadataBytes = bytes.subarray(HEADER_BYTES, HEADER_BYTES + metadataLength);
  let metadataText: string;
  let value: unknown;
  try {
    metadataText = strictDecoder.decode(metadataBytes);
    value = JSON.parse(metadataText);
  } catch (cause) {
    throw invalidFrame("Editable artifact wire metadata is not UTF-8 JSON", cause);
  }
  const metadata = requiredRecord(value, "metadata");
  // Canonical JSON rejects duplicate keys, whitespace variants, and unstable
  // property order before any token or identity is acted on.
  if (JSON.stringify(metadata) !== metadataText) {
    throw invalidFrame("Editable artifact wire metadata is not canonical JSON");
  }
  return Object.freeze({
    kind,
    metadata: Object.freeze(metadata),
    payload: bytes.slice(HEADER_BYTES + metadataLength),
  });
}

function normalizeResume(resume: EditableArtifactLiveResume): EditableArtifactLiveResume {
  if (!resume || typeof resume !== "object") throw invalidFrame("resume must be an object");
  const localCursor = nullableNonnegativeInteger(resume.localCursor, "localCursor");
  const localStateHash =
    resume.localStateHash === null ? null : editableArtifactStateHash(resume.localStateHash);
  const requireSnapshot = requiredBoolean(resume.requireSnapshot, "requireSnapshot");
  if ((localCursor === null) !== (localStateHash === null)) {
    throw invalidFrame("resume cursor and state hash must both be null or both be present");
  }
  const modality = resume.modality ?? "spreadsheet";
  if (modality === "spreadsheet") {
    if (!("localCausalFrontier" in resume)) {
      throw invalidFrame("spreadsheet resume requires a causal frontier");
    }
    return Object.freeze({
      localCursor,
      localStateHash,
      localCausalFrontier: requiredFrontier(resume.localCausalFrontier),
      requireSnapshot,
    });
  }
  editableArtifactLiveModality(modality);
  if (!("localNativeRevision" in resume)) {
    throw invalidFrame("serialized resume requires a native revision");
  }
  const localNativeRevision = nullableNonnegativeInteger(
    resume.localNativeRevision,
    "localNativeRevision",
  );
  if ((localCursor === null) !== (localNativeRevision === null)) {
    throw invalidFrame(
      "serialized resume cursor and native revision must both be null or both be present",
    );
  }
  return Object.freeze({
    modality,
    localCursor,
    localStateHash,
    localNativeRevision,
    requireSnapshot,
  });
}

function requiredFrontier(value: unknown): EditableArtifactCausalFrontier {
  if (!Array.isArray(value) || value.length > MAX_CAUSAL_ACTORS) {
    throw invalidFrame("causal frontier exceeds bound");
  }
  return editableArtifactCausalFrontier(value as EditableArtifactCausalFrontier);
}

function editableArtifactLiveModality(value: unknown): EditableArtifactLiveModality {
  if (value !== "document" && value !== "spreadsheet" && value !== "presentation") {
    throw invalidFrame("editable artifact modality is invalid");
  }
  return value;
}

function clientOpenModality(
  metadata: Readonly<Record<string, unknown>>,
): EditableArtifactLiveModality {
  return metadata.modality === undefined
    ? "spreadsheet"
    : editableArtifactLiveModality(metadata.modality);
}

function serverModality(metadata: Readonly<Record<string, unknown>>): EditableArtifactLiveModality {
  return metadata.modality === undefined
    ? "spreadsheet"
    : editableArtifactLiveModality(metadata.modality);
}

function transactionModality(
  transaction: Readonly<Record<string, unknown>>,
): EditableArtifactLiveModality {
  return transaction.modality === undefined
    ? "spreadsheet"
    : editableArtifactLiveModality(transaction.modality);
}

function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const keys = Object.keys(record);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw invalidFrame("Editable artifact wire metadata fields are invalid or out of order");
  }
}

function requireServerKeys(
  metadata: Readonly<Record<string, unknown>>,
  type: string,
  trailing: readonly string[],
): void {
  requireExactKeys(metadata, ["type", "protocolVersion", "artifactId", "streamEpoch", ...trailing]);
  requireLiteral(metadata.type, type, "type");
}

function serverIdentity<Type extends EditableArtifactLiveServerFrame["type"]>(
  metadata: Readonly<Record<string, unknown>>,
  type: Type,
): Readonly<{
  type: Type;
  protocolVersion: number;
  artifactId: EditableArtifactId;
  streamEpoch: string;
}> {
  return Object.freeze({
    type,
    protocolVersion: positiveInteger(metadata.protocolVersion, "protocolVersion"),
    artifactId: editableArtifactId(requiredString(metadata.artifactId, "artifactId")),
    streamEpoch: boundedString(
      requiredString(metadata.streamEpoch, "streamEpoch"),
      "streamEpoch",
      MAX_IDENTIFIER_BYTES,
    ),
  });
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidFrame(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidFrame(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalidFrame(`${label} must be a string`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalidFrame(`${label} must be boolean`);
  return value;
}

function requireLiteral(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw invalidFrame(`${label} must equal ${expected}`);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidFrame(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidFrame(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function nullableNonnegativeInteger(value: unknown, label: string): number | null {
  return value === null ? null : nonnegativeInteger(value, label);
}

function boundedString(value: string, label: string, maxBytes: number): string {
  const bytes = textEncoder.encode(value).byteLength;
  if (bytes < 1 || bytes > maxBytes || value.trim() !== value) {
    throw invalidFrame(`${label} is malformed`);
  }
  return value;
}

function boundedToken(value: string): string {
  const token = boundedString(value, "token", MAX_TOKEN_BYTES);
  if (!/^[A-Za-z0-9._~-]+$/u.test(token)) throw invalidFrame("token is malformed");
  return token;
}

function editableArtifactId(value: string): EditableArtifactId {
  return stableId(value, "artifact id");
}

function editableArtifactTransactionId(value: string): EditableArtifactTransactionId {
  return stableId(value, "server transaction id");
}

function editableArtifactClientTransactionId(value: string): EditableArtifactClientTransactionId {
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
    throw invalidFrame("clientTransactionId is malformed");
  }
  return value;
}

function editableArtifactRequestHash(value: string): EditableArtifactRequestHash {
  return sha256Text(value, "request hash");
}

function editableArtifactStateHash(value: string): EditableArtifactStateHash {
  return sha256Text(value, "state hash");
}

function editableArtifactContentHash(value: string): EditableArtifactContentHash {
  return sha256Text(value, "content hash");
}

function stableId(value: string, label: string): string {
  if (!/^[0-9a-f]{32}$/u.test(value) || /^0{32}$/u.test(value)) {
    throw invalidFrame(`${label} is malformed`);
  }
  return value;
}

function sha256Text(value: string, label: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw invalidFrame(`${label} is malformed`);
  }
  return value;
}

function editableArtifactCausalFrontier(
  entries: EditableArtifactCausalFrontier,
): EditableArtifactCausalFrontier {
  const seen = new Set<string>();
  const normalized = entries.map((entry, index) => {
    const record = requiredRecord(entry, `causal frontier entry ${index}`);
    requireExactKeys(record, ["replicaId", "counter"]);
    const replicaId = requiredString(record.replicaId, "causal replicaId");
    if (!/^[0-9a-f]{16}$/u.test(replicaId) || /^0{16}$/u.test(replicaId)) {
      throw invalidFrame("causal replicaId is malformed");
    }
    const counter = positiveInteger(record.counter, "causal counter");
    if (seen.has(replicaId)) throw invalidFrame("duplicate causal replicaId");
    seen.add(replicaId);
    return Object.freeze({ replicaId, counter });
  });
  normalized.sort((left, right) =>
    left.replicaId < right.replicaId ? -1 : left.replicaId > right.replicaId ? 1 : 0,
  );
  return Object.freeze(normalized);
}

function ownPayload(value: Uint8Array, maxBytes: number, allowEmpty: boolean): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    (!allowEmpty && value.byteLength === 0) ||
    value.byteLength > maxBytes
  ) {
    throw invalidFrame("Editable artifact wire payload exceeds bound");
  }
  return value.slice();
}

function requireNoPayload(payload: Uint8Array): void {
  if (payload.byteLength !== 0) throw invalidFrame("Frame kind must not carry a binary payload");
}

function invalidFrame(message: string, cause?: unknown): EditableArtifactLiveError {
  return new EditableArtifactLiveError("invalid_frame", message, {
    ...(cause ? { cause } : {}),
  });
}

const EMPTY_BYTES = new Uint8Array(0);
