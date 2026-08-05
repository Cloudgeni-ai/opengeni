import { resolveVoiceInputProviderRegistry, type Settings } from "@opengeni/config";
import { VOICE_INPUT_ACCEPTED_MIME_TYPES } from "@opengeni/contracts";
import {
  filenameForMimeType,
  isAcceptedMimeType,
  normalizeMimeType,
  TRANSCRIPTION_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS,
  type TranscriptionAvailabilityContext,
  type TranscriptionProvider,
  type TranscriptionService,
  TranscriptionServiceError,
} from "@opengeni/core";
import type { Database } from "@opengeni/db";
import { createAzureOpenAiTranscriptionProvider } from "./providers/azure-openai";
import { createCodexSubscriptionTranscriptionProvider } from "./providers/codex-subscription";
import { createOpenAiTranscriptionProvider } from "./providers/openai";

export function createTranscriptionService(input: {
  settings: Settings;
  db: Database;
  fetch?: typeof fetch;
  codexFetch?: typeof fetch;
  probeCodex?: (context?: TranscriptionAvailabilityContext) => boolean | Promise<boolean>;
  /** Test seam for exercising timeout and late-completion behavior quickly. */
  providerRequestTimeoutMilliseconds?: number;
}): TranscriptionService {
  const providers: TranscriptionProvider[] = resolveVoiceInputProviderRegistry(input.settings).map(
    (config) => {
      switch (config.kind) {
        case "openai":
          return createOpenAiTranscriptionProvider({
            ...config,
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
  return {
    limits: () => limits,
    async available(context) {
      return (await Promise.all(providers.map((provider) => provider.available(context)))).some(
        Boolean,
      );
    },
    async selectProvider(context) {
      return (await firstAvailable(providers, context))?.id ?? null;
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
        ? await exactAvailable(providers, request.providerId, { workspaceId: request.workspaceId })
        : await firstAvailable(providers, { workspaceId: request.workspaceId });
      if (!provider) {
        throw new TranscriptionServiceError({
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
      const startedAt = performance.now();
      const deadline = createProviderRequestDeadline(
        request.signal,
        providerRequestTimeoutMilliseconds,
      );
      let result: { text: string; languages: string[] };
      try {
        result = await provider.transcribe({
          audio: request.audio,
          mimeType,
          filename: filenameForMimeType(mimeType),
          workspaceId: request.workspaceId,
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
        throw error;
      } finally {
        deadline.dispose();
      }
      return {
        ...result,
        providerId: provider.id,
        audioSeconds: request.durationSeconds ?? 0,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    },
  };
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
    Math.max(1, timeoutMilliseconds),
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

async function firstAvailable(
  providers: readonly TranscriptionProvider[],
  context: TranscriptionAvailabilityContext,
) {
  for (const provider of providers) {
    if (await provider.available(context)) return provider;
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
