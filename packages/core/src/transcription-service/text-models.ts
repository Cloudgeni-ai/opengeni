import type { VoiceInputPricing, VoiceInputUsage } from "@opengeni/config";
import type { RecordingTranscriptionCapabilities } from "@opengeni/contracts";
import {
  filenameForMimeType,
  normalizeMimeType,
  TranscriptionServiceError,
} from "../transcription";
import type {
  RecordingTranscriptionModelSpec,
  RecordingTranscriptionRequest,
  RecordingTranscriptionResult,
  RecordingTranscriptionScope,
} from "../recording-transcription";

/**
 * What a speech-to-text model that returns plain text can do: no word
 * timings and no speakers of its own. A meeting gets its words placed on the
 * audio by our aligner and its speakers from our diarizer, when the
 * deployment runs them.
 */
export function textModelCapabilities(limits: {
  maxDurationSeconds: number | null;
  maxFileBytes: number | null;
  /** The model also transcribes audio as it streams, for the live transcript. */
  live?: boolean;
}): RecordingTranscriptionCapabilities {
  return {
    batch: true,
    live: limits.live === true,
    diarization: false,
    liveDiarization: false,
    multichannel: false,
    maxSpeakers: null,
    wordTimestamps: false,
    languages: [],
    languageDetection: true,
    keyterms: false,
    speakerLibrary: false,
    maxDurationSeconds: limits.maxDurationSeconds,
    maxFileBytes: limits.maxFileBytes,
  };
}

/** The list price of a credit-priced model per audio hour, in USD. */
export function usdPerHourFromCreditPricing(pricing: VoiceInputPricing | null): number | null {
  if (!pricing) return null;
  return (pricing.microsPerMinute * 60) / 1_000_000;
}

/** A deployment-funded text model priced from the deployment's voice pricing. */
export function deploymentTextModel(input: {
  model: string;
  name: string;
  pricing: VoiceInputPricing | null;
  maxDurationSeconds: number | null;
  maxFileBytes: number | null;
  live?: boolean;
}): RecordingTranscriptionModelSpec {
  return {
    model: input.model,
    name: input.name,
    capabilities: textModelCapabilities(input),
    usdPerHour: usdPerHourFromCreditPricing(input.pricing),
    creditPricing: input.pricing,
  };
}

/** The provider-ready parts of a request for adapters that post one file. */
export function textRequestAudio(request: RecordingTranscriptionRequest): {
  audio: Uint8Array;
  mimeType: string;
  filename: string;
} {
  const mimeType = normalizeMimeType(request.audio.mimeType);
  return {
    audio: request.audio.bytes,
    mimeType,
    filename: request.audio.fileName || filenameForMimeType(mimeType),
  };
}

/** Who the call is for; subscription adapters cannot sign in without it. */
export function requireScope(request: RecordingTranscriptionRequest): RecordingTranscriptionScope {
  if (!request.scope) {
    throw new TranscriptionServiceError({
      code: "unavailable",
      message: "Transcription is unavailable.",
    });
  }
  return request.scope;
}

export function requestIdOf(request: RecordingTranscriptionRequest): string {
  return request.scope?.requestId ?? crypto.randomUUID();
}

export function textTranscriptionResult(input: {
  text: string;
  languages: string[];
  usage?: VoiceInputUsage | null | undefined;
}): RecordingTranscriptionResult {
  return {
    languages: input.languages,
    audioMilliseconds:
      input.usage?.kind === "duration" ? Math.round(input.usage.seconds * 1_000) : null,
    diarized: false,
    words: [],
    text: input.text,
    usage: input.usage ?? null,
  };
}
