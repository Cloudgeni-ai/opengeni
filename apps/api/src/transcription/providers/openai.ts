import { type TranscriptionProvider, TranscriptionServiceError } from "@opengeni/core";

export function createOpenAiTranscriptionProvider(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetch?: typeof fetch;
}): TranscriptionProvider {
  const fetchImpl = input.fetch ?? fetch;
  return {
    id: "openai",
    supportsServerDeadline: true,
    available: () => true,
    async transcribe({ audio, mimeType, filename, requestId, signal }) {
      const form = new FormData();
      form.append("file", audioBlob(audio, mimeType), filename);
      form.append("model", input.model);
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
      if (!body || typeof body.text !== "string") {
        throw new TranscriptionServiceError({
          code: "provider",
          message: "Invalid transcription response.",
        });
      }
      return {
        text: body.text,
        languages: typeof body.language === "string" && body.language ? [body.language] : [],
      };
    },
  };
}

function audioBlob(audio: Uint8Array, mimeType: string): Blob {
  return new Blob([Uint8Array.from(audio).buffer], { type: mimeType });
}

export function responseError(status: number): TranscriptionServiceError {
  if (status === 401 || status === 403) {
    return new TranscriptionServiceError({
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
