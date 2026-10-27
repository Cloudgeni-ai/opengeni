import { voiceInputModelReportsDurationOnly, type VoiceInputPricing } from "@opengeni/config";
import {
  RecordingTranscriptionError,
  type RecordingTranscriptionProvider,
} from "../../recording-transcription";
import {
  deploymentTextModel,
  requestIdOf,
  textRequestAudio,
  textTranscriptionResult,
} from "../text-models";
import {
  fetchError,
  OPENAI_TRANSCRIPTION_LIMITS,
  parseTranscriptionResponseBody,
  responseError,
} from "./openai";
import { createOpenAiRealtimeLiveSession, openAiRealtimeTranscribes } from "./openai-realtime";

export function createAzureOpenAiTranscriptionProvider(input: {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  apiKey: string | null;
  adToken: string | null;
  /**
   * A Microsoft Entra ID token from the deployment's own identity, used when
   * there is neither a key nor a fixed token.
   */
  accessToken?: (() => Promise<string>) | null;
  /** Underlying model of the deployment; defaults to the deployment name. */
  model?: string;
  pricing?: VoiceInputPricing | null;
  fetch?: typeof fetch;
}): RecordingTranscriptionProvider {
  const fetchImpl = input.fetch ?? fetch;
  const model = input.model ?? input.deployment;
  const endpoint = input.endpoint.replace(/\/+$/, "");
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(input.deployment)}/audio/transcriptions?api-version=${encodeURIComponent(input.apiVersion)}`;
  const accessToken = input.accessToken ?? null;
  const auth = async (): Promise<Record<string, string>> => {
    if (input.apiKey) return { "api-key": input.apiKey };
    if (input.adToken) return { Authorization: `Bearer ${input.adToken}` };
    if (accessToken) return { Authorization: `Bearer ${await accessToken()}` };
    throw new RecordingTranscriptionError("Azure OpenAI has no credential", "unauthorized", false);
  };
  return {
    id: "azure-openai",
    name: "Azure OpenAI",
    funding: "deployment",
    models: [
      deploymentTextModel({
        model,
        name: model,
        pricing: input.pricing ?? null,
        ...OPENAI_TRANSCRIPTION_LIMITS,
        live: openAiRealtimeTranscribes(model),
      }),
    ],
    available: () => Boolean(input.apiKey || input.adToken || accessToken),
    async createLiveSession(request) {
      return await createOpenAiRealtimeLiveSession({
        providerName: "Azure OpenAI",
        baseUrl: `${endpoint}/openai/v1`,
        headers: await auth(),
        // Azure names the model by its deployment.
        model: input.deployment,
        request,
        fetch: fetchImpl,
      });
    },
    async transcribe(request) {
      const { audio, mimeType, filename } = textRequestAudio(request);
      const requestId = requestIdOf(request);
      const signal = request.signal;
      const form = new FormData();
      form.append("file", new Blob([Uint8Array.from(audio).buffer], { type: mimeType }), filename);
      if (request.language && /^[a-z]{2}$/u.test(request.language)) {
        form.append("language", request.language);
      }
      // Whisper reports its billed audio duration only in verbose_json.
      if (voiceInputModelReportsDurationOnly(model)) {
        form.append("response_format", "verbose_json");
      }
      const headers: Record<string, string> = {
        ...(await auth()),
        "x-opengeni-request-id": requestId,
      };
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
      return textTranscriptionResult(parsed);
    },
  };
}
