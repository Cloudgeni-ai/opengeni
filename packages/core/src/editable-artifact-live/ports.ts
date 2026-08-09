import type { EditableArtifactAuthorizationPort } from "../domain/editable-artifacts/ports";
import type { EditableArtifactService } from "../domain/editable-artifacts/service";
import type {
  EditableArtifactActor,
  EditableArtifactId,
  EditableArtifactScope,
  EditableArtifactStateHash,
  EditableArtifactTransactionId,
} from "../domain/editable-artifacts/types";
import type {
  EditableArtifactLiveBootstrap,
  EditableArtifactLiveClose,
  EditableArtifactLiveCommittedTransaction,
  EditableArtifactLiveHead,
  EditableArtifactLiveResume,
  EditableArtifactLiveServerFrame,
  EditableArtifactLiveTicketRecord,
} from "./types";

export interface EditableArtifactLiveTicketStorePort {
  put(record: EditableArtifactLiveTicketRecord): Promise<void>;
  /** Atomic take. A token can establish at most one live connection. */
  consume(tokenDigest: string): Promise<EditableArtifactLiveTicketRecord | null>;
}

export interface EditableArtifactLiveTokenPort {
  randomOpaqueToken(): string;
  digestOpaqueToken(token: string): Promise<string>;
}

export interface EditableArtifactLiveClockPort {
  now(): Date;
}

export interface EditableArtifactLiveSchedulerPort {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export type EditableArtifactLiveBootstrapRead = Readonly<{
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  resume: EditableArtifactLiveResume;
  protocolVersion: number;
}>;

export type EditableArtifactLiveTransactionPage = Readonly<{
  transactions: readonly EditableArtifactLiveCommittedTransaction[];
  headSequence: number;
  minimumReplaySequence: number;
}>;

/** Canonical PostgreSQL/object-store read side. Fanout data is never accepted here. */
export interface EditableArtifactLiveReadPort {
  /**
   * Verifies any proposed resume sequence/hash/frontier against durable truth.
   * Snapshot bytes must already have passed digest/size/object-identity checks.
   */
  readBootstrap(input: EditableArtifactLiveBootstrapRead): Promise<EditableArtifactLiveBootstrap>;
  readHead(
    scope: EditableArtifactScope,
    artifactId: EditableArtifactId,
  ): Promise<EditableArtifactLiveHead>;
  readTransactions(
    input: Readonly<{
      scope: EditableArtifactScope;
      artifactId: EditableArtifactId;
      after: number;
      through: number;
      maxCount: number;
      maxBytes: number;
    }>,
  ): Promise<EditableArtifactLiveTransactionPage>;
  readCommittedTransaction(
    input: Readonly<{
      scope: EditableArtifactScope;
      artifactId: EditableArtifactId;
      transactionId: EditableArtifactTransactionId;
    }>,
  ): Promise<EditableArtifactLiveCommittedTransaction | null>;
  /** Advances retention authority only after a verified client apply ACK. */
  acknowledgeReplica(
    input: Readonly<{
      scope: EditableArtifactScope;
      artifactId: EditableArtifactId;
      replicaId: string;
      actorKey: string;
      streamEpoch: string;
      sequence: number;
      stateHash: EditableArtifactStateHash;
    }>,
  ): Promise<void>;
}

export type EditableArtifactLiveHint = Readonly<{
  artifactId: EditableArtifactId;
  headSequence: number;
}>;

export interface EditableArtifactLiveHintPort {
  /** Resolves only after the underlying subscription/flush barrier is active. */
  subscribe(
    input: Readonly<{
      scope: EditableArtifactScope;
      artifactId: EditableArtifactId;
      onHint: (hint: EditableArtifactLiveHint) => void;
      onReconnect: () => void;
    }>,
  ): Promise<() => void>;
}

export interface EditableArtifactLiveAuthorizationInvalidationPort {
  subscribe(
    input: Readonly<{
      scope: EditableArtifactScope;
      artifactId: EditableArtifactId;
      actor: EditableArtifactActor;
      onInvalidated: () => void;
    }>,
  ): Promise<() => void>;
}

/** Adapter-owned socket writer. `send` resolves when the adapter accepts the frame. */
export interface EditableArtifactLiveSinkPort {
  send(frame: EditableArtifactLiveServerFrame): Promise<void>;
  bufferedBytes(): number;
  close(close: EditableArtifactLiveClose): void;
}

export type EditableArtifactLiveServerDependencies = Readonly<{
  authorization: EditableArtifactAuthorizationPort;
  domain: EditableArtifactService;
  tickets: EditableArtifactLiveTicketStorePort;
  tokens: EditableArtifactLiveTokenPort;
  clock: EditableArtifactLiveClockPort;
  scheduler: EditableArtifactLiveSchedulerPort;
  read: EditableArtifactLiveReadPort;
  hints: EditableArtifactLiveHintPort;
  invalidations: EditableArtifactLiveAuthorizationInvalidationPort;
}>;
