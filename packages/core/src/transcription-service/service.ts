import { voiceInputCreditBillingActive, type Settings } from "@opengeni/config";
import { VOICE_INPUT_ACCEPTED_MIME_TYPES } from "@opengeni/contracts";
import { voiceTranscriptionSettlementKeys } from "@opengeni/db";
import { createVoiceInputBilling } from "../domain/voice-input-billing";
import {
  RecordingTranscriptionError,
  type RecordingProviderAudioFormat,
  type RecordingTranscriptionModelSpec,
  type RecordingTranscriptionProvider,
  type RecordingTranscriptionResult,
} from "../recording-transcription";
import {
  filenameForMimeType,
  isAcceptedMimeType,
  normalizeMimeType,
  TRANSCRIPTION_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS,
  type TranscriptionAvailabilityContext,
  type TranscriptionBilling,
  type TranscriptionBillingContext,
  type TranscriptionService,
  TranscriptionServiceError,
} from "../transcription";
import type { Database } from "@opengeni/db";
import {
  createSpeechToTextDeployment,
  type SpeechToTextDeployment,
  type SpeechToTextDeploymentOptions,
} from "./deployment";
import { createFfmpegAudioNormalizer, type TranscriptionAudioNormalizer } from "./normalize";

/**
 * Dictation's view of a provider: the provider and the one model dictation
 * runs on it.
 */
export type DictationProvider = {
  readonly id: string;
  readonly provider: RecordingTranscriptionProvider;
  readonly model: RecordingTranscriptionModelSpec;
};

/**
 * Voice input (one-shot dictation and dictation recordings) over the
 * deployment's speech-to-text providers: the same providers and models
 * meetings use. The service picks a provider in the workspace's or the
 * deployment's order, falls back only after an explicit refusal before any
 * audio was transcribed, bounds every call with a deadline and charges
 * credits for deployment-funded models.
 */
export function createTranscriptionService(input: {
  settings: Settings;
  db: Database;
  /** The deployment's speech-to-text providers; built from settings when absent. */
  deployment?: SpeechToTextDeployment;
  fetch?: typeof fetch;
  codexFetch?: typeof fetch;
  probeCodex?: SpeechToTextDeploymentOptions["probeCodex"];
  /** Test seam for exercising timeout and late-completion behavior quickly. */
  providerRequestTimeoutMilliseconds?: number;
  /** Test seam for evaluating persisted absolute deadlines after delayed setup. */
  now?: () => Date;
  /** Credit admission/settlement for deployment-funded providers. */
  billing?: TranscriptionBilling;
  /** Test seam: trusted one-shot decode + duration (defaults to ffmpeg). */
  normalizeAudio?: TranscriptionAudioNormalizer;
  /** Loud operator log for settlement failures after provider success. */
  log?: (message: string, attributes: Record<string, string | number | boolean>) => void;
  /** In-process settlement retry pacing after an inline failure. */
  settlementRetryDelaysMilliseconds?: readonly number[];
}): TranscriptionService {
  const deployment =
    input.deployment ??
    createSpeechToTextDeployment(
      { settings: input.settings, db: input.db },
      {
        ...(input.fetch ? { fetch: input.fetch } : {}),
        ...(input.codexFetch ? { codexFetch: input.codexFetch } : {}),
        ...(input.probeCodex ? { probeCodex: input.probeCodex } : {}),
      },
    );
  const providers = dictationProviders(deployment);
  const limits = {
    maxDurationSeconds: input.settings.voiceInputMaxDurationSeconds,
    maxSizeBytes: input.settings.voiceInputMaxSizeBytes,
    acceptedMimeTypes: [...VOICE_INPUT_ACCEPTED_MIME_TYPES],
  };
  const providerRequestTimeoutMilliseconds =
    input.providerRequestTimeoutMilliseconds ?? TRANSCRIPTION_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS;
  const now = input.now ?? (() => new Date());
  const log =
    input.log ??
    ((message: string, attributes: Record<string, string | number | boolean>) => {
      console.error(message, attributes);
    });
  const billing =
    input.billing ??
    createVoiceInputBilling({
      db: input.db,
      settings: input.settings,
      onReconcileError: (error, scope) => {
        log("Voice input charge reconciliation failed", {
          ...scope,
          errorClass: error instanceof Error ? error.name : "UnknownError",
          error: boundedErrorMessage(error),
        });
      },
    });
  let normalizer: TranscriptionAudioNormalizer | undefined = input.normalizeAudio;
  const normalizeAudio: TranscriptionAudioNormalizer = (request) => {
    normalizer ??= createFfmpegAudioNormalizer({ ffmpegPath: input.settings.voiceInputFfmpegPath });
    return normalizer(request);
  };
  const retryDelays = input.settlementRetryDelaysMilliseconds ?? [2_000, 15_000, 60_000];
  type Settlement = Parameters<TranscriptionBilling["settle"]>[0];
  /**
   * Post-use settlement never fails the request: the provider already returned
   * text the user is waiting for. A failure is logged with the exact
   * idempotency keys and retried in-process; if the receipt committed but the
   * debit did not, the next admission in the workspace reconciles it.
   */
  const settleWithoutFailing = async (settlement: Settlement): Promise<number> => {
    try {
      return (await billing.settle(settlement)).creditCostMicros;
    } catch (error) {
      reportUnsettled(settlement, error, 0, retryDelays.length > 0 && !deterministic(error));
      if (!deterministic(error)) scheduleSettlementRetry(settlement, 0);
      return 0;
    }
  };
  const deterministic = (error: unknown) => error instanceof TranscriptionServiceError;
  const scheduleSettlementRetry = (settlement: Settlement, attempt: number) => {
    const delay = retryDelays[attempt];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      void billing.settle(settlement).then(
        () => {
          log("Voice input charge settled on retry", {
            ...settlementAttributes(settlement),
            attempt: attempt + 1,
          });
        },
        (error: unknown) => {
          const more = attempt + 1 < retryDelays.length;
          reportUnsettled(settlement, error, attempt + 1, more);
          if (more) scheduleSettlementRetry(settlement, attempt + 1);
        },
      );
    }, delay);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  };
  const reportUnsettled = (
    settlement: Settlement,
    error: unknown,
    attempt: number,
    willRetry: boolean,
  ) => {
    log(
      willRetry
        ? "Voice input charge is unsettled after provider success; retrying"
        : "Voice input charge is UNSETTLED after provider success; manual reconciliation needed unless its usage receipt committed",
      {
        ...settlementAttributes(settlement),
        attempt,
        willRetry,
        errorClass: error instanceof Error ? error.name : "UnknownError",
        error: boundedErrorMessage(error),
      },
    );
  };
  const creditBillingActive = voiceInputCreditBillingActive(input.settings);
  /** Deployment-funded calls are charged; the workspace's own keys and subscriptions never are. */
  const chargeable = (provider: DictationProvider) =>
    creditBillingActive && provider.provider.funding === "deployment";
  const isAvailable = async (
    provider: DictationProvider,
    context: TranscriptionAvailabilityContext,
  ) =>
    deployment.available(
      provider.id,
      context.workspaceId
        ? {
            workspaceId: context.workspaceId,
            ...(context.accountId ? { accountId: context.accountId } : {}),
            ...(context.subjectId ? { subjectId: context.subjectId } : {}),
          }
        : undefined,
    );
  const firstAvailable = async (
    candidates: readonly DictationProvider[],
    context: TranscriptionAvailabilityContext,
  ) => {
    for (const provider of candidates) {
      if (await isAvailable(provider, context)) return provider;
    }
    return null;
  };
  const ordered = (context: TranscriptionAvailabilityContext) =>
    orderedProviders(
      providers,
      deployment.pinned
        ? { ...context, preferredProvider: deployment.pinned.providerId, fallbackEnabled: false }
        : context,
    );
  return {
    limits: () => limits,
    async available(context) {
      return Boolean(await firstAvailable(ordered(context ?? {}), context ?? {}));
    },
    async availableProviderIds(context) {
      // Every ready provider, for the workspace provider picker. One failing
      // probe means that provider is not ready; it never fails the caller.
      const candidates = deployment.pinned
        ? providers.filter((provider) => provider.id === deployment.pinned?.providerId)
        : providers;
      const available = await Promise.all(
        candidates.map(async (provider) =>
          (await isAvailable(provider, context)) ? provider.id : null,
        ),
      );
      return available.filter((id): id is string => id !== null);
    },
    async selectProvider(context) {
      return (await firstAvailable(ordered(context), context))?.id ?? null;
    },
    async admit({ providerId, accountId, workspaceId, attribution }) {
      const provider = providers.find((candidate) => candidate.id === providerId);
      if (!provider || !chargeable(provider)) return;
      await billing.admit({ accountId, workspaceId, attribution });
    },
    async transcribe(request) {
      const mimeType = normalizeMimeType(request.mimeType);
      if (!isAcceptedMimeType(mimeType, limits.acceptedMimeTypes)) {
        throw new TranscriptionServiceError({
          code: "not_supported",
          message: "Unsupported audio format.",
        });
      }
      if (request.audio.byteLength > limits.maxSizeBytes) {
        throw new TranscriptionServiceError({
          code: "too_large",
          message: "Audio is too large.",
        });
      }
      if (
        request.durationSeconds !== undefined &&
        (!Number.isFinite(request.durationSeconds) ||
          request.durationSeconds < 0 ||
          request.durationSeconds > limits.maxDurationSeconds)
      ) {
        throw new TranscriptionServiceError({
          code: "invalid_audio",
          message: "Invalid audio duration.",
        });
      }
      const scopeContext = {
        workspaceId: request.workspaceId,
        accountId: request.accountId,
        subjectId: request.subjectId,
      };
      const exactId = preferredProviderId(request.providerId);
      const pinnedAway = deployment.pinned && exactId && exactId !== deployment.pinned.providerId;
      const exact = exactId ? providers.find((candidate) => candidate.id === exactId) : undefined;
      const provider = request.providerId
        ? !pinnedAway && exact && (await isAvailable(exact, scopeContext))
          ? exact
          : null
        : await firstAvailable(ordered(request), request);
      if (!provider) {
        throw new TranscriptionServiceError({
          fallbackSafe: true,
          code: "unavailable",
          message: "Transcription is unavailable.",
        });
      }
      const fallBack = async (error: unknown) => {
        if (
          error instanceof TranscriptionServiceError &&
          error.fallbackSafe &&
          !request.providerId &&
          request.fallbackEnabled !== false &&
          !deployment.pinned &&
          !request.signal?.aborted
        ) {
          const excludedProviders = [...(request.excludedProviders ?? []), provider.id];
          if (await firstAvailable(ordered({ ...request, excludedProviders }), request)) {
            return await this.transcribe({ ...request, excludedProviders });
          }
        }
        throw error;
      };
      const pricing = provider.model.creditPricing ?? null;
      if (chargeable(provider)) {
        // Fail closed: a deployment-paid call is never sent without a price
        // and a trusted settlement identity.
        if (!pricing || !request.billing) {
          throw new TranscriptionServiceError({
            code: "unavailable",
            message: "Transcription billing is not configured.",
          });
        }
        try {
          await billing.admit({
            accountId: request.accountId,
            workspaceId: request.workspaceId,
            attribution: request.billing.attribution,
          });
        } catch (error) {
          // Nothing was sent yet: a fallback-safe refusal (Opengeni credits
          // turned off here) lets the next provider, such as a connected
          // subscription, serve the request.
          return await fallBack(error);
        }
      }
      const credentials = await deployment.credentials(provider.id, {
        accountId: request.accountId,
        workspaceId: request.workspaceId,
      });
      if (credentials === "missing") {
        return await fallBack(
          new TranscriptionServiceError({
            fallbackSafe: true,
            code: "unavailable",
            message: "Transcription is unavailable.",
          }),
        );
      }
      let audio = request.audio;
      let providerMimeType = mimeType;
      let billingContext: TranscriptionBillingContext | undefined = request.billing;
      let audioSeconds = request.durationSeconds ?? 0;
      const charged = chargeable(provider);
      const needsTrustedDuration = charged && billingContext?.trustedDurationSeconds === undefined;
      if (needsTrustedDuration || !acceptsMimeType(provider.model, mimeType)) {
        // A deployment-paid one-shot upload is decoded by the server first, so
        // the call always carries a duration the server measured from bytes it
        // produced. That bills any usage shape we cannot price, and bounds
        // what is sent upstream to the configured maximum recording length.
        // Models that take only some containers get the same WAV.
        const normalized = await normalizeAudio({
          audio,
          mimeType,
          maxDurationSeconds: limits.maxDurationSeconds,
          ...(request.signal ? { signal: request.signal } : {}),
        });
        audio = normalized.bytes;
        providerMimeType = "audio/wav";
        audioSeconds = normalized.durationSeconds;
        if (needsTrustedDuration) {
          billingContext = {
            ...billingContext!,
            trustedDurationSeconds: normalized.durationSeconds,
          };
        }
      }
      const startedAt = performance.now();
      const remainingMilliseconds = request.providerDeadlineAt
        ? remainingTranscriptionProviderRequestMilliseconds(request.providerDeadlineAt, now())
        : providerRequestTimeoutMilliseconds;
      if (
        request.providerDeadlineAt &&
        (!Number.isFinite(remainingMilliseconds) || remainingMilliseconds <= 0)
      ) {
        throw new TranscriptionServiceError({
          code: "timeout",
          message: "Transcription provider deadline expired.",
          retryable: true,
        });
      }
      const deadline = createProviderRequestDeadline(request.signal, remainingMilliseconds);
      let result: RecordingTranscriptionResult;
      try {
        result = await provider.provider.transcribe(
          {
            audio: {
              bytes: audio,
              mimeType: providerMimeType,
              fileName: filenameForMimeType(providerMimeType),
            },
            model: provider.model.model,
            diarize: false,
            signal: deadline.signal,
            scope: {
              accountId: request.accountId,
              workspaceId: request.workspaceId,
              subjectId: request.subjectId,
              requestId: request.requestId,
            },
          },
          credentials.credentials,
        );
        if (deadline.timedOut && !request.signal?.aborted) {
          throw new TranscriptionServiceError({
            code: "timeout",
            message: "Transcription provider timed out.",
            retryable: true,
          });
        }
      } catch (error) {
        if (deadline.timedOut && !request.signal?.aborted) {
          throw new TranscriptionServiceError({
            code: "timeout",
            message: "Transcription provider timed out.",
            retryable: true,
          });
        }
        return await fallBack(asTranscriptionServiceError(error));
      } finally {
        deadline.dispose();
      }
      const latencyMs = Math.round(performance.now() - startedAt);
      let creditCostMicros = 0;
      const settle = async () => {
        if (charged && pricing && billingContext) {
          creditCostMicros = await settleWithoutFailing({
            accountId: request.accountId,
            workspaceId: request.workspaceId,
            providerId: provider.id,
            model: provider.model.model,
            pricing,
            usage: result.usage ?? null,
            billing: billingContext,
          });
        }
      };
      if (!request.deferBillingSettlement) await settle();
      return {
        text: transcriptText(result),
        languages: result.languages,
        providerId: provider.id,
        audioSeconds,
        latencyMs,
        creditCostMicros,
        ...(request.deferBillingSettlement ? { settleBilling: settle } : {}),
      };
    },
  };
}

/**
 * The providers dictation can use, in the deployment's order, each with the
 * model it runs: the pinned model, else the provider's first file model.
 */
export function dictationProviders(deployment: SpeechToTextDeployment): DictationProvider[] {
  return deployment.order.flatMap((id) => {
    const provider = deployment.registry.get(id);
    if (!provider) return [];
    const model =
      (deployment.pinned?.providerId === id
        ? provider.models.find((candidate) => candidate.model === deployment.pinned?.model)
        : undefined) ?? provider.models.find((candidate) => candidate.capabilities.batch);
    return model ? [{ id, provider, model }] : [];
  });
}

/** The text of a result: the model's own text, or its words joined. */
export function transcriptText(result: RecordingTranscriptionResult): string {
  if (result.text !== undefined) return result.text;
  let text = "";
  for (const word of result.words) {
    if (word.text.length === 0) continue;
    const joinsPrevious = /^[,.;:!?%)\]}]/u.test(word.text) || text.length === 0;
    text += joinsPrevious ? word.text : ` ${word.text}`;
  }
  return text.trim();
}

const AUDIO_FORMAT_MIME_TYPES: Record<RecordingProviderAudioFormat, readonly string[]> = {
  flac: ["audio/flac", "audio/x-flac"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  mp3: ["audio/mpeg", "audio/mp3"],
  webm: ["audio/webm"],
  mp4: ["audio/mp4", "audio/m4a", "audio/x-m4a"],
};

function acceptsMimeType(model: RecordingTranscriptionModelSpec, mimeType: string): boolean {
  if (!model.audioFormats) return true;
  return model.audioFormats.some((format) => AUDIO_FORMAT_MIME_TYPES[format].includes(mimeType));
}

/**
 * Errors from providers that speak the recording error vocabulary become
 * voice input errors. Rejections that mean nothing was transcribed
 * (unauthorized, quota, rate limits) are safe to try another provider with.
 */
export function asTranscriptionServiceError(error: unknown): unknown {
  if (!(error instanceof RecordingTranscriptionError)) return error;
  switch (error.code) {
    case "unauthorized":
    case "quota_exceeded":
    case "rate_limited":
      return new TranscriptionServiceError({
        fallbackSafe: true,
        code: "unavailable",
        message: "Transcription is unavailable.",
        retryable: error.retryable,
      });
    case "invalid_audio":
      return new TranscriptionServiceError({
        code: "invalid_audio",
        message: "Audio could not be transcribed.",
      });
    case "too_large":
      return new TranscriptionServiceError({ code: "too_large", message: "Audio is too large." });
    case "not_supported":
      return new TranscriptionServiceError({
        code: "not_supported",
        message: "Unsupported audio format.",
      });
    case "timeout":
      return new TranscriptionServiceError({
        code: "timeout",
        message: "Transcription timed out.",
        retryable: true,
      });
    case "network":
      return new TranscriptionServiceError({
        code: "network",
        message: "Transcription provider is unreachable.",
        retryable: true,
      });
    case "unavailable":
      return new TranscriptionServiceError({
        code: "unavailable",
        message: "Transcription provider failed.",
        retryable: true,
      });
    case "provider":
    default:
      return new TranscriptionServiceError({
        code: "provider",
        message: "Transcription provider failed.",
        retryable: error.retryable,
      });
  }
}

/**
 * Errors from the voice input adapters become recording errors, for the
 * meeting pipeline, which speaks that vocabulary.
 */
export function asRecordingTranscriptionError(error: unknown): unknown {
  if (!(error instanceof TranscriptionServiceError)) return error;
  const code = ((): RecordingTranscriptionError["code"] => {
    switch (error.code) {
      case "invalid_audio":
        return "invalid_audio";
      case "too_large":
        return "too_large";
      case "not_supported":
        return "not_supported";
      case "timeout":
        return "timeout";
      case "network":
        return "network";
      case "unavailable":
        return error.fallbackSafe ? "unauthorized" : "unavailable";
      default:
        return "provider";
    }
  })();
  return new RecordingTranscriptionError(error.message, code, error.retryable);
}

export function remainingTranscriptionProviderRequestMilliseconds(
  providerDeadlineAt: Date,
  now: Date,
): number {
  return providerDeadlineAt.getTime() - now.getTime();
}

function createProviderRequestDeadline(
  parentSignal: AbortSignal | undefined,
  timeoutMilliseconds: number,
): { signal: AbortSignal; readonly timedOut: boolean; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      controller.abort(new DOMException("Transcription provider timed out", "TimeoutError"));
    },
    Math.max(1, Math.ceil(timeoutMilliseconds)),
  );
  const abortFromParent = () => {
    controller.abort(parentSignal?.reason);
  };
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export function orderedProviders<Provider extends { readonly id: string }>(
  providers: readonly Provider[],
  context: TranscriptionAvailabilityContext,
): Provider[] {
  const preferredId = preferredProviderId(context.preferredProvider);
  const preferred = providers.filter((provider) => provider.id === preferredId);
  const ordered = preferredId
    ? context.fallbackEnabled === false
      ? preferred
      : [...preferred, ...providers.filter((provider) => provider.id !== preferredId)]
    : context.fallbackEnabled === false
      ? providers.slice(0, 1)
      : [...providers];
  const remaining = context.afterProvider
    ? ordered.slice(ordered.findIndex((provider) => provider.id === context.afterProvider) + 1)
    : ordered;
  return remaining.filter((provider) => !context.excludedProviders?.includes(provider.id));
}

/** The voice input's MAI provider is now the Azure Speech provider. */
function preferredProviderId(id: string | null | undefined): string | null | undefined {
  return id === "azure-mai" ? "azure-speech" : id;
}

function settlementAttributes(settlement: {
  accountId: string;
  workspaceId: string;
  providerId: string;
  billing: TranscriptionBillingContext;
}): Record<string, string> {
  const keys = voiceTranscriptionSettlementKeys({
    workspaceId: settlement.workspaceId,
    sourceId: settlement.billing.sourceId,
  });
  return {
    accountId: settlement.accountId,
    workspaceId: settlement.workspaceId,
    providerId: settlement.providerId,
    sourceId: settlement.billing.sourceId,
    usageIdempotencyKey: keys.usageIdempotencyKey,
    debitIdempotencyKey: keys.debitIdempotencyKey,
  };
}

function boundedErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
