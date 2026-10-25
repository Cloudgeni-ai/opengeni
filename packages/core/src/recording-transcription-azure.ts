import type { RecordingTranscriptionCapabilities } from "@opengeni/contracts";
import {
  canonicalLanguageTag,
  RecordingTranscriptionError,
  type RecordingTranscribedWord,
  type RecordingTranscriptionCredentials,
  type RecordingTranscriptionProvider,
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
};

function milliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/** Characters that attach to the word before them rather than starting a new one. */
const ATTACHED_PUNCTUATION = /^[.,!?;:…%)\]}»"'’”。、，！？]+$/u;

/** Turn Azure Speech phrases and their words into our words. */
export function parseAzureSpeechTranscript(body: unknown): RecordingTranscriptionResult {
  if (!body || typeof body !== "object") {
    throw new RecordingTranscriptionError("Azure Speech returned no transcript", "provider", true);
  }
  const response = body as { durationMilliseconds?: unknown; phrases?: unknown };
  const phrases = Array.isArray(response.phrases) ? (response.phrases as AzureSpeechPhrase[]) : [];
  const words: RecordingTranscribedWord[] = [];
  const languages = new Set<string>();
  for (const phrase of phrases) {
    if (typeof phrase?.locale === "string" && phrase.locale) {
      languages.add(canonicalLanguageTag(phrase.locale));
    }
    const items = Array.isArray(phrase?.words) ? (phrase.words as AzureSpeechWord[]) : [];
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
  return {
    languages: [...languages],
    audioMilliseconds: milliseconds(response.durationMilliseconds),
    diarized: false,
    words,
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

function azureSpeechError(status: number, code: string | null): RecordingTranscriptionError {
  const message = `Azure Speech could not transcribe this audio (HTTP ${status}${code ? `: ${code}` : ""})`;
  if (status === 401 || status === 403) {
    return new RecordingTranscriptionError(message, "unauthorized", false);
  }
  if (status === 413 || code === "AudioLengthLimitExceeded") {
    return new RecordingTranscriptionError(message, "too_large", false);
  }
  if (status === 400 || status === 415 || status === 422) {
    return new RecordingTranscriptionError(message, "invalid_audio", false);
  }
  if (status === 429) return new RecordingTranscriptionError(message, "rate_limited", true);
  if (status === 408 || status >= 500) {
    return new RecordingTranscriptionError(message, "unavailable", true);
  }
  return new RecordingTranscriptionError(message, "provider", false);
}

/** Speech errors are JSON with a code; MAI wraps its own. Only the code is kept. */
async function azureSpeechErrorCode(response: Response): Promise<string | null> {
  const text = await response.text().catch(() => "");
  return /"code"\s*:\s*"([A-Za-z_]{1,60})"/u.exec(text)?.[1] ?? null;
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
  fetch?: typeof fetch;
  timeoutMilliseconds?: number;
}): RecordingTranscriptionProvider {
  const request = options.fetch ?? fetch;
  const url = `${options.endpoint.replace(/\/+$/u, "")}/speechtotext/transcriptions:transcribe?api-version=${AZURE_SPEECH_API_VERSION}`;
  return {
    id: AZURE_SPEECH_PROVIDER_ID,
    name: "Azure Speech",
    models: [
      {
        model: "MAI-Transcribe-2",
        name: "MAI-Transcribe-2",
        capabilities: MAI_TRANSCRIBE_CAPABILITIES,
        // Launch price through 2026; Microsoft has not published the later one.
        usdPerHour: 0.1,
        audioFormats: ["flac", "wav", "mp3"],
      },
    ],
    async transcribe(input, credentials) {
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
          headers: azureSpeechAuthorization(credentials),
          body: form,
          signal,
        });
      } catch (error) {
        if (timeout.aborted) {
          throw new RecordingTranscriptionError("Azure Speech took too long", "timeout", true);
        }
        if (input.signal?.aborted) throw error;
        throw new RecordingTranscriptionError("Could not reach Azure Speech", "network", true);
      }
      if (!response.ok) {
        throw azureSpeechError(response.status, await azureSpeechErrorCode(response));
      }
      return parseAzureSpeechTranscript(await response.json().catch(() => null));
    },
  };
}
