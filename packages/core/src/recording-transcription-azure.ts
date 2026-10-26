import type { VoiceInputPricing } from "@opengeni/config";
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
  const words: RecordingTranscribedWord[] = [];
  const languages = new Set<string>();
  for (const phrase of phrases) {
    const items = Array.isArray(phrase?.words) ? (phrase.words as AzureSpeechWord[]) : [];
    // Azure labels audio it heard no language in as "unk"; that is no language.
    const locale = typeof phrase?.locale === "string" ? phrase.locale.trim() : "";
    if (items.length > 0 && locale && !UNKNOWN_LOCALES.has(locale.toLowerCase())) {
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
  // The whole text as the service punctuates it, which dictation uses.
  const combined = Array.isArray(response.combinedPhrases)
    ? (response.combinedPhrases as Array<{ text?: unknown }>)
        .map((phrase) => (typeof phrase?.text === "string" ? phrase.text.trim() : ""))
        .filter((text) => text.length > 0)
        .join(" ")
    : null;
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
        throw new RecordingTranscriptionError("Could not reach Azure Speech", "network", true);
      }
      if (!response.ok) {
        throw azureSpeechError(response.status, await azureSpeechErrorCode(response));
      }
      return parseAzureSpeechTranscript(await response.json().catch(() => null));
    },
  };
}
