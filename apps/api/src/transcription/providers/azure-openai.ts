import { voiceInputModelReportsDurationOnly, type VoiceInputPricing } from "@opengeni/config";
import type { TranscriptionProvider } from "@opengeni/core";
import { fetchError, parseTranscriptionResponseBody, responseError } from "./openai";

export function createAzureOpenAiTranscriptionProvider(input: {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  apiKey: string | null;
  adToken: string | null;
  /** Underlying model of the deployment; defaults to the deployment name. */
  model?: string;
  pricing?: VoiceInputPricing | null;
  fetch?: typeof fetch;
}): TranscriptionProvider {
  const fetchImpl = input.fetch ?? fetch;
  const model = input.model ?? input.deployment;
  const url = `${input.endpoint}/openai/deployments/${encodeURIComponent(input.deployment)}/audio/transcriptions?api-version=${encodeURIComponent(input.apiVersion)}`;
  return {
    id: "azure-openai",
    supportsServerDeadline: true,
    deploymentFunded: { model, pricing: input.pricing ?? null },
    available: () => Boolean(input.apiKey || input.adToken),
    async transcribe({ audio, mimeType, filename, requestId, signal }) {
      const form = new FormData();
      form.append("file", new Blob([Uint8Array.from(audio).buffer], { type: mimeType }), filename);
      // Whisper reports its billed audio duration only in verbose_json.
      if (voiceInputModelReportsDurationOnly(model)) {
        form.append("response_format", "verbose_json");
      }
      const headers: Record<string, string> = input.apiKey
        ? { "api-key": input.apiKey, "x-opengeni-request-id": requestId }
        : { Authorization: `Bearer ${input.adToken}`, "x-opengeni-request-id": requestId };
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers,
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
        throw responseError(502);
      }
      return parsed;
    },
  };
}
