import type { VoiceInputPricing } from "@opengeni/config";
import { type TranscriptionProvider, TranscriptionServiceError } from "@opengeni/core";
import { createFfmpegTranscriptionSegmenter, TranscriptionSegmenterError } from "../segmenter";
import { fetchError, responseError } from "./openai";

/** Azure Speech file transcription; credentials and model selection stay server-side. */
export function createMaiTranscriptionProvider(input: {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  model: string;
  pricing?: VoiceInputPricing | null;
  ffmpegPath: string;
  fetch?: typeof fetch;
}): TranscriptionProvider {
  const fetchImpl = input.fetch ?? fetch;
  const segmenter = createFfmpegTranscriptionSegmenter({ ffmpegPath: input.ffmpegPath });
  return {
    id: "azure-mai",
    supportsServerDeadline: true,
    deploymentFunded: { model: input.model, pricing: input.pricing ?? null },
    available: () => Boolean(input.apiKey),
    async transcribe({ audio, mimeType, filename, requestId, signal }) {
      let bytes = audio;
      let contentType = mimeType;
      let name = filename;
      // Resumable recordings already arrive as WAV. Legacy browser recordings
      // need the same bounded decoder before entering Speech's file API.
      if (!["audio/wav", "audio/x-wav", "audio/mpeg", "audio/flac"].includes(mimeType)) {
        try {
          const segments = segmenter.segment({
            sourceMimeType: mimeType,
            chunks: (async function* () {
              yield audio;
            })(),
            providerSegmentSeconds: 600,
            totalDurationMilliseconds: 600_000,
            ...(signal ? { signal } : {}),
          });
          let normalized: Uint8Array | undefined;
          for await (const segment of segments) {
            if (normalized)
              throw new TranscriptionServiceError({
                code: "too_large",
                message: "Audio is too long.",
              });
            normalized = segment.bytes;
          }
          if (!normalized)
            throw new TranscriptionServiceError({
              code: "invalid_audio",
              message: "Audio could not be decoded.",
            });
          bytes = normalized;
          contentType = "audio/wav";
          name = "audio.wav";
        } catch (error) {
          if (error instanceof TranscriptionSegmenterError) {
            throw new TranscriptionServiceError({
              code: error.code === "unknown" ? "invalid_audio" : error.code,
              message: "Audio could not be prepared for transcription.",
              retryable: error.retryable,
            });
          }
          throw error;
        }
      }
      const form = new FormData();
      form.append("audio", new Blob([Uint8Array.from(bytes).buffer], { type: contentType }), name);
      form.append(
        "definition",
        JSON.stringify({ enhancedMode: { enabled: true, model: input.model } }),
      );
      let response: Response;
      try {
        response = await fetchImpl(
          `${input.endpoint.replace(/\/+$/, "")}/speechtotext/transcriptions:transcribe?api-version=${encodeURIComponent(input.apiVersion)}`,
          {
            method: "POST",
            headers: {
              "Ocp-Apim-Subscription-Key": input.apiKey,
              "x-opengeni-request-id": requestId,
            },
            body: form,
            ...(signal ? { signal } : {}),
          },
        );
      } catch (error) {
        throw fetchError(error);
      }
      if (!response.ok) throw responseError(response.status);
      const body = await response.json().catch(() => null);
      if (
        !body ||
        !Array.isArray(body.combinedPhrases) ||
        !body.combinedPhrases.every(
          (phrase: unknown) =>
            typeof phrase === "object" &&
            phrase !== null &&
            "text" in phrase &&
            typeof phrase.text === "string",
        )
      ) {
        throw responseError(502);
      }
      return {
        usage:
          typeof body.durationMilliseconds === "number" &&
          Number.isFinite(body.durationMilliseconds) &&
          body.durationMilliseconds >= 0
            ? { kind: "duration" as const, seconds: body.durationMilliseconds / 1000 }
            : null,
        text: body.combinedPhrases.map((phrase: { text: string }) => phrase.text).join("\n"),
        languages: [
          ...new Set<string>(
            (Array.isArray(body.phrases) ? body.phrases : []).flatMap(
              (phrase: { locale?: unknown }) =>
                typeof phrase?.locale === "string" && phrase.locale ? [phrase.locale] : [],
            ),
          ),
        ],
      };
    },
  };
}
