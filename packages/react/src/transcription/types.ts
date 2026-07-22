export type TranscriptionPhase =
  | "idle"
  | "requesting-permission"
  | "listening"
  | "reconnecting"
  | "cancelling"
  | "closed"
  | "error";

export type TranscriptionWord = {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  speaker?: string;
};

export type TranscriptionUsage =
  | {
      unit: "tokens";
      totalTokens: number;
      inputTokens?: number;
      outputTokens?: number;
      inputTokenDetails?: Record<string, number>;
    }
  | { unit: "duration_seconds"; seconds: number }
  | { unit: "audio_seconds"; seconds: number }
  | { unit: "currency_micros"; amountMicros: number; currency: string };

type TranscriptionEventBase = {
  /** OpenGeni-generated ID for one local dictation session. */
  sessionId: string;
  providerId: string;
  /** Monotonic sequence assigned at the provider adapter boundary. */
  sequence: number;
  providerEventId?: string;
  emittedAt?: string;
};

type TranscriptEventBase = TranscriptionEventBase & {
  /** Zero-based provider/fallback attempt. */
  attempt: number;
  /** Provider segment/item identity for this attempt. */
  segmentId: string;
  /** OpenGeni identity retained across fallback attempts. */
  logicalSegmentId: string;
  text: string;
  language?: string;
  confidence?: number;
  speaker?: string;
  startMs?: number;
  endMs?: number;
  words?: TranscriptionWord[];
};

export type TranscriptionEvent =
  | (TranscriptionEventBase & {
      type: "session.ready";
      providerSessionId?: string;
      expiresAt?: number;
    })
  | (TranscriptEventBase & { type: "transcript.partial" })
  | (TranscriptEventBase & {
      type: "transcript.final";
      /** Provider acknowledgement used for replay diagnostics and deduplication. */
      providerAcceptanceId: string;
    })
  | (TranscriptionEventBase & {
      type: "usage";
      usage: TranscriptionUsage;
    })
  | (TranscriptionEventBase & {
      type: "reconnecting";
      attempt: number;
      reason?: string;
      retryInMs?: number;
    })
  | (TranscriptionEventBase & {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
      permissionDenied?: boolean;
    })
  | (TranscriptionEventBase & {
      type: "closed";
      reason: "completed" | "cancelled" | "provider_closed" | "error";
    });

export type TranscriptionEventSink = (event: TranscriptionEvent) => void;

export type TranscriptionPrivacyRequest = {
  /** Adapters must reject unsupported privacy choices rather than silently weakening them. */
  retainAudio: boolean;
  retainTranscript: boolean;
  trainingAllowed: boolean;
  region?: string;
  dataResidency?: string;
};

export type TranscriptionSessionRequest = {
  sessionId: string;
  language?: string;
  diarization?: boolean;
  privacy: TranscriptionPrivacyRequest;
};

export interface TranscriptionSession {
  readonly id: string;
  readonly providerId: string;
  start(): Promise<void>;
  cancel(reason?: string): Promise<void>;
  close(): Promise<void>;
}

export interface TranscriptionProvider {
  readonly id: string;
  createSession(
    request: TranscriptionSessionRequest,
    emit: TranscriptionEventSink,
  ): TranscriptionSession;
}

export type TranscriptionPartial = Extract<TranscriptionEvent, { type: "transcript.partial" }>;

export type TranscriptionCommit = {
  id: string;
  sessionId: string;
  providerId: string;
  providerAcceptanceId: string;
  providerEventId?: string;
  segmentId: string;
  logicalSegmentId: string;
  attempt: number;
  sequence: number;
  text: string;
  language?: string;
  confidence?: number;
  speaker?: string;
  startMs?: number;
  endMs?: number;
  words?: TranscriptionWord[];
};

export type TranscriptionError = {
  code: string;
  message: string;
  retryable: boolean;
  permissionDenied: boolean;
};

export type TranscriptionState = {
  phase: TranscriptionPhase;
  activeSessionId: string | null;
  partial: TranscriptionPartial | null;
  highestSequenceBySegment: Record<string, number>;
  acceptedFinalByLogicalSegment: Record<string, string>;
  acceptedCommits: TranscriptionCommit[];
  latestCommit: TranscriptionCommit | null;
  acceptedUsage: TranscriptionUsage[];
  acceptedUsageEventIds: Record<string, true>;
  reconnectAttempt: number;
  retryInMs: number | null;
  error: TranscriptionError | null;
  closedReason: Extract<TranscriptionEvent, { type: "closed" }>["reason"] | null;
};

export type TranscriptionReducerAction =
  | { type: "start.requested"; sessionId: string }
  | { type: "cancel.requested" }
  | { type: "cancel.completed" }
  | { type: "reset" }
  | { type: "provider.event"; event: TranscriptionEvent };
