import type { VoiceInputPricing, VoiceInputUsage } from "@opengeni/config";
import type { TranscribeAudioResponse, VoiceInputErrorCode } from "@opengeni/contracts";
import type { CreditDebitAttribution } from "@opengeni/db";

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
  /** Authenticated human/service subject used for provider-account authority. */
  subjectId: string;
  audio: Uint8Array;
  mimeType: string;
  /** Optional client-reported duration; enforced as a soft ceiling before upstream. */
  durationSeconds?: number | undefined;
  signal?: AbortSignal | undefined;
  requestId: string;
  /** Absolute server-owned provider deadline persisted for resumable attempts. */
  providerDeadlineAt?: Date | undefined;
  /** Exact provider selected before a resumable segment is first sent upstream. */
  providerId?: string | undefined;
  preferredProvider?: string | null | undefined;
  fallbackEnabled?: boolean | undefined;
  excludedProviders?: readonly string[] | undefined;
  /**
   * Credit settlement facts for a deployment-funded provider. Required when
   * the selected provider is deployment-funded and credit billing is active;
   * the service fails closed without it.
   */
  billing?: TranscriptionBillingContext | undefined;
  /**
   * Internal: return `settleBilling` instead of settling before returning, so
   * a resumable segment's transcript commits before any billing write.
   */
  deferBillingSettlement?: boolean;
};

/**
 * Trusted, server-built settlement identity for one transcription unit. The
 * usage receipt and debit idempotency keys derive from `workspaceId` +
 * `sourceId` (see `voiceInputSettlementKeys`), so a retry or a later
 * reconciliation settles the same unit exactly once.
 */
export type TranscriptionBillingContext = {
  /**
   * Server-derived unit identity. Never a client-chosen value: a reused id
   * settles once, so a client-controlled id would make later calls free.
   */
  sourceId: string;
  /** Trusted payer facts from the authenticated request boundary. */
  attribution: CreditDebitAttribution;
  /**
   * Audio duration measured by the server from WAV bytes it produced (the
   * resumable segment, or the normalized one-shot upload). Bills whenever the
   * provider reports no usage this deployment has a price for.
   */
  trustedDurationSeconds?: number | undefined;
};

export type TranscriptionResult = TranscribeAudioResponse & {
  /** Server-private provider id for operational metrics only. Never returned to clients. */
  providerId: string;
  audioSeconds: number;
  latencyMs: number;
  /** Opengeni credits charged for this call (0 for subscription/free providers). */
  creditCostMicros?: number | undefined;
  /**
   * Server-only settlement callback; never serialized into a public response.
   * Never rejects: a settlement failure after provider success is logged and
   * retried, and the transcript is still delivered.
   */
  settleBilling?: () => Promise<void>;
};

export type TranscriptionBillingRefusalCode =
  | "insufficient_credits"
  | "allowance_exhausted"
  | "monthly_model_cost_limit";

/**
 * Pre-use refusal for deployment-funded transcription: 402 for credits and
 * allowances (same codes as session admission), 429 for a static monthly cap.
 */
export class TranscriptionBillingRefusedError extends Error {
  readonly status: 402 | 429;
  readonly code: TranscriptionBillingRefusalCode;
  readonly details: { scope?: string; resetsAt?: string | null; subjectId?: string };

  constructor(input: {
    code: TranscriptionBillingRefusalCode;
    message: string;
    details?: { scope?: string; resetsAt?: string | null; subjectId?: string };
  }) {
    super(input.message);
    this.name = "TranscriptionBillingRefusedError";
    this.code = input.code;
    this.status = input.code === "monthly_model_cost_limit" ? 429 : 402;
    this.details = input.details ?? {};
  }
}

/**
 * Credit admission and settlement for deployment-funded transcription.
 * Subscription providers (Codex, SuperGrok) never reach this port.
 */
export type TranscriptionBilling = {
  /** Refuse before any audio is sent when the payer cannot fund the call. */
  admit(input: {
    accountId: string;
    workspaceId: string;
    attribution: CreditDebitAttribution;
  }): Promise<void>;
  /**
   * Record usage and debit credits once per unit, after use. The usage receipt
   * commits before the debit, so a failed debit leaves a durable receipt that
   * `admit` reconciles on the workspace's next voice request.
   */
  settle(input: {
    accountId: string;
    workspaceId: string;
    providerId: string;
    model: string;
    pricing: VoiceInputPricing;
    usage: VoiceInputUsage | null;
    billing: TranscriptionBillingContext;
  }): Promise<{ creditCostMicros: number }>;
};

export class TranscriptionServiceError extends Error {
  readonly code: Exclude<VoiceInputErrorCode, TranscriptionBillingRefusalCode>;
  readonly status: number;
  readonly retryable: boolean;
  /** Explicit rejection before any transcription result; safe to try another provider. */
  readonly fallbackSafe: boolean;

  constructor(input: {
    code: Exclude<VoiceInputErrorCode, TranscriptionBillingRefusalCode>;
    message: string;
    status?: number;
    retryable?: boolean;
    fallbackSafe?: boolean;
  }) {
    super(input.message);
    this.name = "TranscriptionServiceError";
    this.code = input.code;
    this.status = input.status ?? statusForVoiceInputError(input.code);
    this.retryable = input.retryable ?? false;
    this.fallbackSafe = input.fallbackSafe ?? false;
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
  afterProvider?: string | undefined;
  preferredProvider?: string | null | undefined;
  fallbackEnabled?: boolean | undefined;
  excludedProviders?: readonly string[] | undefined;
  workspaceId?: string | undefined;
  subjectId?: string | undefined;
};

/**
 * Extensible transcription provider port. Implementations own credentials and
 * upstream request shape. Selection happens before audio is sent; providers must
 * only fall back after an explicit rejection and before any successful or
 * uncertain provider attempt. Recording persistence owns that eligibility.
 */
export type TranscriptionProvider = {
  readonly id: string;
  /** The adapter guarantees that its upstream transport honors AbortSignal. */
  readonly supportsServerDeadline: true;
  readonly experimental?: boolean | undefined;
  /**
   * Present when the deployment pays the upstream provider (OpenAI/Azure):
   * the call is admitted against and settled in Opengeni credits. Absent for
   * the workspace's own subscriptions, which are never charged.
   */
  readonly deploymentFunded?:
    | { readonly model: string; readonly pricing: VoiceInputPricing | null }
    | undefined;
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
    accountId: string;
    subjectId: string;
    requestId: string;
    signal?: AbortSignal | undefined;
  }): Promise<{ text: string; languages: string[]; usage?: VoiceInputUsage | null | undefined }>;
};

export type TranscriptionService = {
  limits(): TranscriptionLimits;
  /** True when at least one ready provider can serve requests. */
  available(context?: TranscriptionAvailabilityContext): boolean | Promise<boolean>;
  availableProviderIds?(context: TranscriptionAvailabilityContext): Promise<string[]>;
  /** Select one provider before a durable segment attempt; retries pin this id. */
  selectProvider?(
    context: TranscriptionAvailabilityContext,
  ): string | null | Promise<string | null>;
  /**
   * Credit admission for an exact provider before durable work is claimed.
   * Resolves for subscription providers; throws TranscriptionBillingRefusedError
   * when a deployment-funded provider cannot be paid for.
   */
  admit?(input: {
    providerId: string;
    accountId: string;
    workspaceId: string;
    attribution: CreditDebitAttribution;
  }): Promise<void>;
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
    /** Hard decode ceiling (`ffmpeg -t`); audio past it is never decoded. */
    maxDecodeSeconds?: number | undefined;
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
