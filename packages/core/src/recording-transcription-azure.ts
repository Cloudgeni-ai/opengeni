import type { VoiceInputPricing } from "@opengeni/config";
import type { RecordingTranscriptionCapabilities } from "@opengeni/contracts";
import {
  canonicalLanguageTag,
  RecordingTranscriptionError,
  transcriptionProviderOutOfCredit,
  type RecordingTranscribedWord,
  type RecordingTranscriptionCredentials,
  type RecordingTranscriptionProvider,
  type RecordingTranscriptionRequestTiming,
  type RecordingTranscriptionResult,
} from "./recording-transcription";

/**
 * Azure Speech's fast transcription API with Microsoft's MAI-Transcribe
 * models. Audio is processed in the Speech account's own region, so a
 * deployment that needs data residency picks the region by picking the
 * account. The account is the deployment's, not a workspace's: its endpoint
 * comes from settings, and it accepts either its key or a Microsoft Entra ID
 * token.
 */

export const AZURE_SPEECH_PROVIDER_ID = "azure-speech";
const AZURE_SPEECH_API_VERSION = "2025-10-15";
/** One hour of audio takes the model seconds; minutes means something is wrong. */
const AZURE_SPEECH_REQUEST_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;
/**
 * What Microsoft documents for fast transcription
 * (learn.microsoft.com/azure/ai-services/speech-service/fast-transcription-create):
 * it answers faster than real time, it may accept a request and then time
 * out without answering, and transient failures are retried up to five
 * times after 2, 4, 8, 16 and 32 seconds. So a request unanswered after its
 * audio's length has failed and is sent again on that schedule, instead of
 * waiting for whatever ends the connection.
 */
const AZURE_SPEECH_REQUEST_TIMING: RecordingTranscriptionRequestTiming = {
  realTimeFactor: 1,
  retryDelaysMilliseconds: [2_000, 4_000, 8_000, 16_000, 32_000],
};

/**
 * MAI-Transcribe-2 in enhanced mode. The REST reference caps one request at
 * two hours and 250 MB; longer tracks are sent in pieces. The model's own
 * diarization fails on recordings past about a quarter of an hour during the
 * preview, so speakers come from our diarizer instead.
 */
const MAI_TRANSCRIBE_CAPABILITIES: RecordingTranscriptionCapabilities = {
  batch: true,
  live: false,
  diarization: false,
  liveDiarization: false,
  multichannel: false,
  maxSpeakers: null,
  wordTimestamps: true,
  languages: [],
  languageDetection: true,
  keyterms: true,
  speakerLibrary: false,
  maxDurationSeconds: 2 * 60 * 60,
  maxFileBytes: 250 * 1024 * 1024,
};

type AzureSpeechWord = {
  text?: unknown;
  offsetMilliseconds?: unknown;
  durationMilliseconds?: unknown;
};

type AzureSpeechPhrase = {
  locale?: unknown;
  words?: unknown;
  text?: unknown;
};

function milliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/** Characters that attach to the word before them rather than starting a new one. */
const ATTACHED_PUNCTUATION = /^[.,!?;:…%)\]}»"'’”。、，！？]+$/u;

/** Locales Azure Speech reports for audio in no language it recognized. */
const UNKNOWN_LOCALES = new Set(["unk", "und"]);

/** Turn Azure Speech phrases and their words into our words. */
export function parseAzureSpeechTranscript(body: unknown): RecordingTranscriptionResult {
  if (!body || typeof body !== "object") {
    throw new RecordingTranscriptionError("Azure Speech returned no transcript", "provider", true);
  }
  const response = body as {
    durationMilliseconds?: unknown;
    phrases?: unknown;
    combinedPhrases?: unknown;
  };
  const phrases = Array.isArray(response.phrases) ? (response.phrases as AzureSpeechPhrase[]) : [];
  // The whole text as the service punctuates it, which dictation uses.
  const combined = Array.isArray(response.combinedPhrases)
    ? (response.combinedPhrases as Array<{ text?: unknown }>)
        .map((phrase) => (typeof phrase?.text === "string" ? phrase.text.trim() : ""))
        .filter((text) => text.length > 0)
        .join(" ")
    : null;
  const words: RecordingTranscribedWord[] = [];
  const languages = new Set<string>();
  for (const phrase of phrases) {
    const items = Array.isArray(phrase?.words) ? (phrase.words as AzureSpeechWord[]) : [];
    // A language counts where something was said in it: the phrase has words
    // or text, or the transcript has text and the phrase carries no words of
    // its own. Azure labels audio it heard no language in as "unk".
    const locale = typeof phrase?.locale === "string" ? phrase.locale.trim() : "";
    const said =
      items.length > 0 ||
      (typeof phrase?.text === "string" && phrase.text.trim() !== "") ||
      Boolean(combined);
    if (said && locale && !UNKNOWN_LOCALES.has(locale.toLowerCase())) {
      languages.add(canonicalLanguageTag(locale));
    }
    for (const item of items) {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      const start = milliseconds(item.offsetMilliseconds);
      const duration = milliseconds(item.durationMilliseconds);
      if (!text || start === null) continue;
      words.push({
        text,
        startMilliseconds: start,
        endMilliseconds: start + (duration ?? 0),
        speaker: null,
        spaceBefore: words.length > 0 && !ATTACHED_PUNCTUATION.test(text),
      });
    }
  }
  words.sort((left, right) => left.startMilliseconds - right.startMilliseconds);
  const audioMilliseconds = milliseconds(response.durationMilliseconds);
  return {
    languages: [...languages],
    audioMilliseconds,
    diarized: false,
    words,
    ...(combined !== null ? { text: combined } : {}),
    usage:
      audioMilliseconds === null ? null : { kind: "duration", seconds: audioMilliseconds / 1_000 },
  };
}

/**
 * The one locale Azure Speech takes. Norwegian without a variant is sent as
 * Bokmål, the written form almost everyone uses.
 */
export function azureSpeechLocale(code: string): string {
  const tag = canonicalLanguageTag(code).toLowerCase();
  if (tag === "no" || tag === "nor" || tag === "nob" || tag.startsWith("nb")) return "nb";
  if (tag === "nno" || tag.startsWith("nn")) return "nn";
  return tag.split("-")[0] ?? tag;
}

function azureSpeechError(
  status: number,
  failure: AzureSpeechFailure,
): RecordingTranscriptionError {
  const { code } = failure;
  const message = `Azure Speech could not transcribe this audio (HTTP ${status}${code ? `: ${code}` : ""})`;
  const detail = {
    status,
    ...(code ? { providerCode: code } : {}),
    ...(failure.message ? { providerMessage: failure.message } : {}),
    ...(failure.requestId ? { requestId: failure.requestId } : {}),
  };
  const error = (errorCode: RecordingTranscriptionError["code"], retryable: boolean) =>
    new RecordingTranscriptionError(message, errorCode, retryable, detail);
  // The free tier's spent quota comes back as 403, like a rejected key.
  if (failure.outOfCredit) return error("quota_exceeded", false);
  if (status === 401 || status === 403) return error("unauthorized", false);
  if (status === 413 || code === "AudioLengthLimitExceeded") return error("too_large", false);
  if (status === 400 || status === 415 || status === 422) return error("invalid_audio", false);
  if (status === 429) return error("rate_limited", true);
  if (status === 408 || status >= 500) return error("unavailable", true);
  return error("provider", false);
}

type AzureSpeechFailure = {
  code: string | null;
  message: string | null;
  requestId: string | null;
  outOfCredit: boolean;
};

/**
 * What a failed response says: Speech errors are JSON with a code and a
 * message, which MAI wraps in its own text. The message is the service's,
 * never the audio's words.
 */
async function azureSpeechFailure(response: Response): Promise<AzureSpeechFailure> {
  const text = await response.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: its text is read as it is.
  }
  const quoted = /"message"\s*:\s*("(?:[^"\\]|\\.){1,2000}")/u.exec(text)?.[1];
  let message: string | null = null;
  try {
    message = quoted ? (JSON.parse(quoted) as string) : null;
  } catch {
    message = null;
  }
  // A gateway's own error page is HTML, which says nothing the status doesn't.
  if (!message && text.trim() && !text.trimStart().startsWith("<")) message = text.trim();
  return {
    code: /"code"\s*:\s*"([A-Za-z_]{1,60})"/u.exec(text)?.[1] ?? null,
    message: message ? message.slice(0, 2_000) : null,
    requestId: azureSpeechRequestId(response),
    outOfCredit: transcriptionProviderOutOfCredit(body),
  };
}

/** Azure's id for the request, which its support asks for. */
function azureSpeechRequestId(response: Response): string | null {
  for (const header of ["apim-request-id", "x-ms-request-id", "x-requestid", "x-request-id"]) {
    const value = response.headers.get(header)?.trim();
    if (value) return value.slice(0, 128);
  }
  return null;
}

/** What the transport said when no answer came: its code (ECONNRESET) and message. */
function transportFailure(error: unknown): { providerCode?: string; providerMessage?: string } {
  if (!(error instanceof Error)) return {};
  const code = (error as { code?: unknown }).code;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode =
    cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  const transportCode = typeof code === "string" ? code : causeCode;
  return {
    ...(typeof transportCode === "string" && transportCode ? { providerCode: transportCode } : {}),
    providerMessage: `${error.name}: ${error.message}`.slice(0, 2_000),
  };
}

function azureSpeechAuthorization(
  credentials: RecordingTranscriptionCredentials,
): Record<string, string> {
  if ("accessToken" in credentials) return { Authorization: `Bearer ${credentials.accessToken}` };
  return { "Ocp-Apim-Subscription-Key": credentials.apiKey };
}

/** Azure Speech on the deployment's own Speech account. */
export function createAzureSpeechRecordingTranscriptionProvider(options: {
  /** The account's HTTPS origin, such as https://name.cognitiveservices.azure.com. */
  endpoint: string;
  /**
   * The account's key or Entra token, held by the deployment. When set it
   * is used for every call; otherwise the caller passes one.
   */
  credentials?: () => Promise<RecordingTranscriptionCredentials>;
  /** The deployment's credit price for this account, where credit billing is on. */
  creditPricing?: VoiceInputPricing | null;
  apiVersion?: string;
  fetch?: typeof fetch;
  timeoutMilliseconds?: number;
}): RecordingTranscriptionProvider {
  const request = options.fetch ?? fetch;
  const url = `${options.endpoint.replace(/\/+$/u, "")}/speechtotext/transcriptions:transcribe?api-version=${encodeURIComponent(options.apiVersion ?? AZURE_SPEECH_API_VERSION)}`;
  return {
    id: AZURE_SPEECH_PROVIDER_ID,
    name: "Azure Speech",
    funding: "deployment",
    requestTiming: AZURE_SPEECH_REQUEST_TIMING,
    models: [
      {
        model: "MAI-Transcribe-2",
        name: "MAI-Transcribe-2",
        capabilities: MAI_TRANSCRIBE_CAPABILITIES,
        // Launch price through 2026; Microsoft has not published the later one.
        usdPerHour: 0.1,
        audioFormats: ["flac", "wav", "mp3"],
        ...(options.creditPricing !== undefined ? { creditPricing: options.creditPricing } : {}),
      },
    ],
    async transcribe(input, credentials) {
      const auth = options.credentials ? await options.credentials() : credentials;
      if (!auth) {
        throw new RecordingTranscriptionError(
          "Azure Speech has no credential",
          "unauthorized",
          false,
        );
      }
      const definition = {
        enhancedMode: {
          enabled: true,
          model: input.model,
          modelOptions: { timestamps: "word" },
        },
        ...(input.language ? { locales: [azureSpeechLocale(input.language)] } : {}),
        ...(input.keyterms && input.keyterms.length > 0
          ? { phraseList: { phrases: [...input.keyterms] } }
          : {}),
      };
      const form = new FormData();
      form.append(
        "audio",
        new Blob([input.audio.bytes as Uint8Array<ArrayBuffer>], { type: input.audio.mimeType }),
        input.audio.fileName,
      );
      form.append("definition", JSON.stringify(definition));
      const timeout = AbortSignal.timeout(
        options.timeoutMilliseconds ?? AZURE_SPEECH_REQUEST_TIMEOUT_MILLISECONDS,
      );
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await request(url, {
          method: "POST",
          headers: azureSpeechAuthorization(auth),
          body: form,
          signal,
        });
      } catch (error) {
        if (timeout.aborted) {
          throw new RecordingTranscriptionError("Azure Speech took too long", "timeout", true);
        }
        if (input.signal?.aborted) throw error;
        throw new RecordingTranscriptionError(
          "Could not reach Azure Speech",
          "network",
          true,
          transportFailure(error),
        );
      }
      if (!response.ok) {
        throw azureSpeechError(response.status, await azureSpeechFailure(response));
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (timeout.aborted) {
          throw new RecordingTranscriptionError("Azure Speech took too long", "timeout", true);
        }
        if (input.signal?.aborted) throw error;
        // The answer was cut off on its way back.
        const requestId = azureSpeechRequestId(response);
        throw new RecordingTranscriptionError(
          "Azure Speech's answer was cut off",
          "network",
          true,
          {
            status: response.status,
            ...transportFailure(error),
            ...(requestId ? { requestId } : {}),
          },
        );
      }
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // Not a transcript: parsed as none below.
      }
      try {
        return parseAzureSpeechTranscript(body);
      } catch (error) {
        if (!(error instanceof RecordingTranscriptionError)) throw error;
        const requestId = azureSpeechRequestId(response);
        throw new RecordingTranscriptionError(error.message, error.code, error.retryable, {
          status: response.status,
          ...(requestId ? { requestId } : {}),
        });
      }
    },
  };
}
