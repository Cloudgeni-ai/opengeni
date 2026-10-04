import {
  voiceInputModelReportsDurationOnly,
  type VoiceInputPricing,
  type VoiceInputUsage,
} from "@opengeni/config";
import { type TranscriptionProvider, TranscriptionServiceError } from "@opengeni/core";

export function createOpenAiTranscriptionProvider(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  pricing?: VoiceInputPricing | null;
  fetch?: typeof fetch;
}): TranscriptionProvider {
  const fetchImpl = input.fetch ?? fetch;
  return {
    id: "openai",
    supportsServerDeadline: true,
    deploymentFunded: { model: input.model, pricing: input.pricing ?? null },
    available: () => true,
    async transcribe({ audio, mimeType, filename, requestId, signal }) {
      const form = new FormData();
      form.append("file", audioBlob(audio, mimeType), filename);
      form.append("model", input.model);
      // Whisper reports its billed audio duration only in verbose_json.
      if (voiceInputModelReportsDurationOnly(input.model)) {
        form.append("response_format", "verbose_json");
      }
      let response: Response;
      try {
        response = await fetchImpl(`${input.baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.apiKey}`,
            // Observability only; the upstream API is not treated as idempotent.
            "x-opengeni-request-id": requestId,
          },
          body: form,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw fetchError(error);
      }
      if (!response.ok) throw responseError(response.status);
      const body = await response.json().catch(() => null);
      const parsed = parseTranscriptionResponseBody(body);
      if (!parsed) {
        throw new TranscriptionServiceError({
          code: "provider",
          message: "Invalid transcription response.",
        });
      }
      return parsed;
    },
  };
}

/**
 * OpenAI-compatible `/audio/transcriptions` JSON (OpenAI and Azure OpenAI).
 * `usage` is `{type:"tokens", input_tokens, input_token_details:{audio_tokens,
 * text_tokens}, output_tokens, total_tokens}` for the gpt-4o-transcribe family
 * or `{type:"duration", seconds}` for duration-billed models; Whisper
 * `verbose_json` carries the processed audio `duration`. Unusable usage is
 * dropped (null), never guessed.
 */
export function parseTranscriptionResponseBody(
  body: unknown,
): { text: string; languages: string[]; usage: VoiceInputUsage | null } | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.text !== "string") return null;
  const languages =
    typeof record.language === "string" && record.language
      ? [record.language]
      : Array.isArray(record.languages)
        ? record.languages.filter(
            (language): language is string => typeof language === "string" && language !== "",
          )
        : [];
  return { text: record.text, languages, usage: parseTranscriptionUsage(record) };
}

export function parseTranscriptionUsage(body: Record<string, unknown>): VoiceInputUsage | null {
  const usage = body.usage;
  if (usage && typeof usage === "object") {
    const record = usage as Record<string, unknown>;
    if (record.type === "tokens") {
      const inputTokens = count(record.input_tokens);
      const outputTokens = count(record.output_tokens);
      if (inputTokens !== null && outputTokens !== null) {
        const details =
          record.input_token_details && typeof record.input_token_details === "object"
            ? (record.input_token_details as Record<string, unknown>)
            : {};
        return {
          kind: "tokens",
          inputTokens,
          audioInputTokens: count(details.audio_tokens) ?? 0,
          textInputTokens: count(details.text_tokens) ?? 0,
          outputTokens,
        };
      }
    }
    if (record.type === "duration" && seconds(record.seconds) !== null) {
      return { kind: "duration", seconds: seconds(record.seconds)! };
    }
  }
  const duration = seconds(body.duration);
  return duration === null ? null : { kind: "duration", seconds: duration };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 86_400
    ? value
    : null;
}

function audioBlob(audio: Uint8Array, mimeType: string): Blob {
  return new Blob([Uint8Array.from(audio).buffer], { type: mimeType });
}

export function responseError(status: number): TranscriptionServiceError {
  if (status === 401 || status === 403) {
    return new TranscriptionServiceError({
      fallbackSafe: true,
      code: "unavailable",
      message: "Transcription is unavailable.",
    });
  }
  if (status === 413) {
    return new TranscriptionServiceError({
      code: "too_large",
      message: "Audio is too large.",
    });
  }
  if (status === 400 || status === 422) {
    return new TranscriptionServiceError({
      code: "invalid_audio",
      message: "Audio could not be transcribed.",
    });
  }
  if (status === 408 || status === 504) {
    return new TranscriptionServiceError({
      code: "timeout",
      message: "Transcription timed out.",
      retryable: true,
    });
  }
  return new TranscriptionServiceError({
    code: status >= 500 ? "unavailable" : "provider",
    message: "Transcription provider failed.",
    retryable: status >= 500,
  });
}

export function fetchError(error: unknown): TranscriptionServiceError {
  if (error instanceof DOMException && error.name === "AbortError") {
    return new TranscriptionServiceError({
      code: "cancelled",
      message: "Transcription was cancelled.",
    });
  }
  return new TranscriptionServiceError({
    code: "network",
    message: "Transcription provider is unreachable.",
    retryable: true,
  });
}
