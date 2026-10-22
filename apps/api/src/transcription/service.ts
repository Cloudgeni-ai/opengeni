import {
  resolveVoiceInputProviderRegistry,
  voiceInputCreditBillingActive,
  type Settings,
} from "@opengeni/config";
import { VOICE_INPUT_ACCEPTED_MIME_TYPES } from "@opengeni/contracts";
import { voiceTranscriptionSettlementKeys } from "@opengeni/db";
import {
  createVoiceInputBilling,
  filenameForMimeType,
  isAcceptedMimeType,
  normalizeMimeType,
  TRANSCRIPTION_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS,
  type TranscriptionAvailabilityContext,
  type TranscriptionBilling,
  type TranscriptionBillingContext,
  type TranscriptionProvider,
  type TranscriptionService,
  TranscriptionServiceError,
} from "@opengeni/core";
import type { Database } from "@opengeni/db";
import { createFfmpegAudioNormalizer, type TranscriptionAudioNormalizer } from "./normalize";
import { createMaiTranscriptionProvider } from "./providers/azure-mai";
import { createAzureOpenAiTranscriptionProvider } from "./providers/azure-openai";
import { createCodexSubscriptionTranscriptionProvider } from "./providers/codex-subscription";
import { createOpenAiTranscriptionProvider } from "./providers/openai";
import { createXaiSubscriptionTranscriptionProvider } from "./providers/xai-subscription";

export function createTranscriptionService(input: {
  settings: Settings;
  db: Database;
  fetch?: typeof fetch;
  codexFetch?: typeof fetch;
  probeCodex?: (context?: TranscriptionAvailabilityContext) => boolean | Promise<boolean>;
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
  const providers: TranscriptionProvider[] = resolveVoiceInputProviderRegistry(input.settings).map(
    (config) => {
      switch (config.kind) {
        case "openai":
          return createOpenAiTranscriptionProvider({
            ...config,
            ...(input.fetch ? { fetch: input.fetch } : {}),
          });
        case "azure-mai":
          return createMaiTranscriptionProvider({
            ...config,
            ffmpegPath: input.settings.voiceInputFfmpegPath,
            ...(input.fetch ? { fetch: input.fetch } : {}),
          });
        case "azure-openai":
          return createAzureOpenAiTranscriptionProvider({
            ...config,
            ...(input.fetch ? { fetch: input.fetch } : {}),
          });
        case "codex-subscription":
          return createCodexSubscriptionTranscriptionProvider({
            settings: input.settings,
            db: input.db,
            ...(input.codexFetch ? { fetch: input.codexFetch } : {}),
            ...(input.probeCodex ? { probe: input.probeCodex } : {}),
          });
        case "supergrok-subscription":
          return createXaiSubscriptionTranscriptionProvider({
            settings: input.settings,
            db: input.db,
            ...(input.fetch ? { fetch: input.fetch } : {}),
          });
        default:
          throw new Error("Unsupported voice-input provider.");
      }
    },
  );
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
  /** Deployment-funded calls are charged; the workspace's own subscriptions never are. */
  const chargeable = (provider: TranscriptionProvider) =>
    creditBillingActive && provider.deploymentFunded !== undefined;
  return {
    limits: () => limits,
    async available(context) {
      return Boolean(
        await firstAvailable(orderedProviders(providers, context ?? {}), context ?? {}),
      );
    },
    async availableProviderIds(context) {
      // Every ready provider, for the workspace provider picker. One failing
      // probe means that provider is not ready; it never fails the caller.
      const available = await Promise.all(
        providers.map(async (provider) => {
          try {
            return (await provider.available(context)) ? provider.id : null;
          } catch {
            return null;
          }
        }),
      );
      return available.filter((id): id is string => id !== null);
    },
    async selectProvider(context) {
      return (await firstAvailable(orderedProviders(providers, context), context))?.id ?? null;
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
      const provider = request.providerId
        ? await exactAvailable(providers, request.providerId, {
            workspaceId: request.workspaceId,
            subjectId: request.subjectId,
          })
        : await firstAvailable(orderedProviders(providers, request), request);
      if (!provider) {
        throw new TranscriptionServiceError({
          fallbackSafe: true,
          code: "unavailable",
          message: "Transcription is unavailable.",
        });
      }
      if (provider.supportsServerDeadline !== true) {
        throw new TranscriptionServiceError({
          code: "unavailable",
          message: "Transcription provider does not support bounded requests.",
        });
      }
      if (chargeable(provider)) {
        // Fail closed: a deployment-paid call is never sent without a price
        // and a trusted settlement identity.
        if (!provider.deploymentFunded?.pricing || !request.billing) {
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
          if (
            error instanceof TranscriptionServiceError &&
            error.fallbackSafe &&
            !request.providerId &&
            request.fallbackEnabled !== false &&
            !request.signal?.aborted
          ) {
            const excludedProviders = [...(request.excludedProviders ?? []), provider.id];
            if (
              await firstAvailable(
                orderedProviders(providers, { ...request, excludedProviders }),
                request,
              )
            ) {
              return await this.transcribe({ ...request, excludedProviders });
            }
          }
          throw error;
        }
      }
      let audio = request.audio;
      let providerMimeType = mimeType;
      let billingContext: TranscriptionBillingContext | undefined = request.billing;
      let audioSeconds = request.durationSeconds ?? 0;
      if (chargeable(provider) && billingContext?.trustedDurationSeconds === undefined) {
        // A deployment-paid one-shot upload is decoded by the server first, so
        // the call always carries a duration the server measured from bytes it
        // produced. That bills any usage shape we cannot price, and bounds
        // what is sent upstream to the configured maximum recording length.
        const normalized = await normalizeAudio({
          audio,
          mimeType,
          maxDurationSeconds: limits.maxDurationSeconds,
          ...(request.signal ? { signal: request.signal } : {}),
        });
        audio = normalized.bytes;
        providerMimeType = "audio/wav";
        audioSeconds = normalized.durationSeconds;
        billingContext = { ...billingContext!, trustedDurationSeconds: normalized.durationSeconds };
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
      let result: Awaited<ReturnType<TranscriptionProvider["transcribe"]>>;
      try {
        result = await provider.transcribe({
          audio,
          mimeType: providerMimeType,
          filename: filenameForMimeType(providerMimeType),
          workspaceId: request.workspaceId,
          accountId: request.accountId,
          subjectId: request.subjectId,
          requestId: request.requestId,
          signal: deadline.signal,
        });
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
        if (
          error instanceof TranscriptionServiceError &&
          error.fallbackSafe &&
          !request.providerId &&
          request.fallbackEnabled !== false &&
          !request.signal?.aborted
        ) {
          const excludedProviders = [...(request.excludedProviders ?? []), provider.id];
          if (
            await firstAvailable(
              orderedProviders(providers, { ...request, excludedProviders }),
              request,
            )
          ) {
            return await this.transcribe({ ...request, excludedProviders });
          }
        }
        throw error;
      } finally {
        deadline.dispose();
      }
      const latencyMs = Math.round(performance.now() - startedAt);
      let creditCostMicros = 0;
      const settle = async () => {
        if (chargeable(provider) && provider.deploymentFunded?.pricing && billingContext) {
          creditCostMicros = await settleWithoutFailing({
            accountId: request.accountId,
            workspaceId: request.workspaceId,
            providerId: provider.id,
            model: provider.deploymentFunded.model,
            pricing: provider.deploymentFunded.pricing,
            usage: result.usage ?? null,
            billing: billingContext,
          });
        }
      };
      if (!request.deferBillingSettlement) await settle();
      return {
        text: result.text,
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

export function orderedProviders(
  providers: readonly TranscriptionProvider[],
  context: TranscriptionAvailabilityContext,
): TranscriptionProvider[] {
  const preferred = providers.filter((provider) => provider.id === context.preferredProvider);
  const ordered = context.preferredProvider
    ? context.fallbackEnabled === false
      ? preferred
      : [...preferred, ...providers.filter((provider) => provider.id !== context.preferredProvider)]
    : context.fallbackEnabled === false
      ? providers.slice(0, 1)
      : [...providers];
  const remaining = context.afterProvider
    ? ordered.slice(ordered.findIndex((provider) => provider.id === context.afterProvider) + 1)
    : ordered;
  return remaining.filter((provider) => !context.excludedProviders?.includes(provider.id));
}

async function firstAvailable(
  providers: readonly TranscriptionProvider[],
  context: TranscriptionAvailabilityContext,
) {
  for (const provider of providers) {
    try {
      if (await provider.available(context)) return provider;
    } catch {
      /* No audio sent; another configured provider may be ready. */
    }
  }
  return null;
}

async function exactAvailable(
  providers: readonly TranscriptionProvider[],
  providerId: string,
  context: TranscriptionAvailabilityContext,
) {
  const provider = providers.find((candidate) => candidate.id === providerId);
  return provider && (await provider.available(context)) ? provider : null;
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
