import type {
  EditableArtifactActor,
  EditableArtifactCausalFrontier,
  EditableArtifactClientTransactionId,
  EditableArtifactContentHash,
  EditableArtifactId,
  EditableArtifactModality,
  EditableArtifactRequestHash,
  EditableArtifactScope,
  EditableArtifactStateHash,
  EditableArtifactTransactionId,
} from "../domain/editable-artifacts/types";

export const EDITABLE_ARTIFACT_LIVE_PROTOCOL_VERSION = 1;

export type EditableArtifactLiveTicket = Readonly<{
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  replicaId: string;
  token: string;
  expiresAt: string;
  protocolVersion: number;
}>;

/** Stored under a digest of the opaque token and atomically consumed once. */
export type EditableArtifactLiveTicketRecord = Readonly<{
  tokenDigest: string;
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  actor: EditableArtifactActor;
  /** Delegated ceiling captured by the authenticated ticket-minting request. */
  allowEdit: boolean;
  protocolVersion: number;
  issuedAt: string;
  expiresAt: string;
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
        modality: "spreadsheet";
        causalFrontier: EditableArtifactCausalFrontier;
        operationProtocolVersion: number;
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
        modality: "spreadsheet";
        causalFrontier: EditableArtifactCausalFrontier;
        operationProtocolVersion: number;
      }>)
  | (EditableArtifactLiveCommittedTransactionCommon &
      Readonly<{
        modality: "document" | "presentation";
        priorNativeRevision: number;
        nativeRevision: number;
        commitProtocolVersion: number;
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

type EditableArtifactLiveResumeCommon = Readonly<{
  localCursor: number | null;
  localStateHash: EditableArtifactStateHash | null;
  requireSnapshot: boolean;
}>;

export type EditableArtifactLiveResume =
  | (EditableArtifactLiveResumeCommon &
      Readonly<{
        modality?: "spreadsheet";
        localCausalFrontier: EditableArtifactCausalFrontier;
      }>)
  | (EditableArtifactLiveResumeCommon &
      Readonly<{
        modality: "document" | "presentation";
        localNativeRevision: number | null;
      }>);

export type EditableArtifactLiveServerFrame =
  | Readonly<{
      type: "open";
      protocolVersion: number;
      artifactId: EditableArtifactId;
      streamEpoch: string;
      modality: EditableArtifactModality;
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
            modality: "spreadsheet";
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
