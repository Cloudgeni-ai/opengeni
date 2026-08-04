import { resolveVoiceInputProviderRegistry, type Settings } from "@opengeni/config";
import { VOICE_INPUT_ACCEPTED_MIME_TYPES } from "@opengeni/contracts";
import {
  filenameForMimeType,
  isAcceptedMimeType,
  normalizeMimeType,
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
      const startedAt = performance.now();
      const result = await provider.transcribe({
        audio: request.audio,
        mimeType,
        filename: filenameForMimeType(mimeType),
        workspaceId: request.workspaceId,
        signal: request.signal,
      });
      return {
        ...result,
        providerId: provider.id,
        audioSeconds: request.durationSeconds ?? 0,
        latencyMs: Math.round(performance.now() - startedAt),
      };
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
