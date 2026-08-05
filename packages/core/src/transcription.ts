import type { TranscribeAudioResponse, VoiceInputErrorCode } from "@opengeni/contracts";

/**
 * Server-owned upstream budget for one provider attempt. Resumable recording
 * claims remain fenced for longer than this budget before another worker may
 * reclaim them. Provider adapters must honor the supplied AbortSignal and must
 * not return while their upstream request is still live; OpenGeni does not
 * claim remote-side idempotency or cancellation for vendors that cannot meet
 * that adapter contract.
 */
export const TRANSCRIPTION_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS = 10 * 60 * 1_000;

export type TranscriptionLimits = {
  maxDurationSeconds: number;
  maxSizeBytes: number;
  acceptedMimeTypes: readonly string[];
};

export type TranscriptionRequest = {
  workspaceId: string;
  accountId: string;
  audio: Uint8Array;
  mimeType: string;
  /** Optional client-reported duration; enforced as a soft ceiling before upstream. */
  durationSeconds?: number | undefined;
  signal?: AbortSignal | undefined;
  requestId: string;
  /** Exact provider selected before a resumable segment is first sent upstream. */
  providerId?: string | undefined;
};

export type TranscriptionResult = TranscribeAudioResponse & {
  /** Server-private provider id for operational metrics only. Never returned to clients. */
  providerId: string;
  audioSeconds: number;
  latencyMs: number;
};

export class TranscriptionServiceError extends Error {
  readonly code: VoiceInputErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(input: {
    code: VoiceInputErrorCode;
    message: string;
    status?: number;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "TranscriptionServiceError";
    this.code = input.code;
    this.status = input.status ?? statusForVoiceInputError(input.code);
    this.retryable = input.retryable ?? false;
  }
}

export function statusForVoiceInputError(code: VoiceInputErrorCode): number {
  switch (code) {
    case "permission_denied":
      return 403;
    case "policy_blocked":
      return 403;
    case "not_supported":
      return 415;
    case "unavailable":
      return 503;
    case "too_large":
      return 413;
    case "invalid_audio":
      return 400;
    case "timeout":
      return 504;
    case "cancelled":
      return 499;
    case "network":
    case "provider":
      return 502;
    case "unknown":
    default:
      return 500;
  }
}

/** Optional workspace scope for readiness checks during provider selection. */
export type TranscriptionAvailabilityContext = {
  workspaceId?: string | undefined;
};

/**
 * Extensible transcription provider port. Implementations own credentials and
 * upstream request shape. Selection happens before audio is sent; providers must
 * not fall back to another vendor after an upstream request may have started.
 */
export type TranscriptionProvider = {
  readonly id: string;
  /** The adapter guarantees that its upstream transport honors AbortSignal. */
  readonly supportsServerDeadline: true;
  readonly experimental?: boolean | undefined;
  /**
   * Deployment readiness when called without a workspace. When `workspaceId` is
   * provided, providers may require a workspace-attached credential (e.g. Codex).
   */
  available(context?: TranscriptionAvailabilityContext): boolean | Promise<boolean>;
  transcribe(input: {
    audio: Uint8Array;
    mimeType: string;
    filename: string;
    workspaceId: string;
    requestId: string;
    signal?: AbortSignal | undefined;
  }): Promise<{ text: string; languages: string[] }>;
};

export type TranscriptionService = {
  limits(): TranscriptionLimits;
  /** True when at least one ready provider can serve requests. */
  available(context?: TranscriptionAvailabilityContext): boolean | Promise<boolean>;
  /** Select one provider before a durable segment attempt; retries pin this id. */
  selectProvider?(
    context: TranscriptionAvailabilityContext,
  ): string | null | Promise<string | null>;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
};

export type PreparedTranscriptionSegment = {
  segmentNumber: number;
  startMilliseconds: number;
  durationMilliseconds: number;
  mimeType: "audio/wav";
  bytes: Uint8Array;
};

export type TranscriptionSegmenter = {
  available(): boolean | Promise<boolean>;
  segment(input: {
    sourceMimeType: string;
    totalDurationMilliseconds: number;
    providerSegmentSeconds: number;
    chunks: AsyncIterable<Uint8Array>;
    signal?: AbortSignal | undefined;
  }): AsyncIterable<PreparedTranscriptionSegment>;
};

export function normalizeMimeType(mimeType: string): string {
  return mimeType.trim().toLowerCase();
}

export function isAcceptedMimeType(mimeType: string, accepted: readonly string[]): boolean {
  const normalized = normalizeMimeType(mimeType);
  if (accepted.some((candidate) => normalizeMimeType(candidate) === normalized)) {
    return true;
  }
  // Allow bare type matches against codec-qualified allowlist entries.
  const bare = normalized.split(";")[0]?.trim() ?? normalized;
  return accepted.some((candidate) => {
    const allowed = normalizeMimeType(candidate);
    return allowed === bare || allowed.split(";")[0]?.trim() === bare;
  });
}

export function filenameForMimeType(mimeType: string): string {
  const bare = normalizeMimeType(mimeType).split(";")[0] ?? "audio/webm";
  switch (bare) {
    case "audio/mp4":
    case "audio/m4a":
      return "audio.mp4";
    case "audio/ogg":
      return "audio.ogg";
    case "audio/mpeg":
    case "audio/mp3":
      return "audio.mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "audio.wav";
    case "audio/webm":
    default:
      return "audio.webm";
  }
}
