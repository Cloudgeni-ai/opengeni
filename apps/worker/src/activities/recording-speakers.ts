// Our own speaker models for meeting recordings: the `opengeni-speakers`
// executable (apps/worker/speakers, Rust on ONNX Runtime) tells speakers
// apart, embeds voices and places a text-only transcript's words on the
// audio, all on the worker's CPU. ffmpeg decodes the track to
// 16 kHz mono float PCM and pipes it straight in, so no decoded copy of the
// audio is written to disk.

import type {
  RecordingAlignedWords,
  RecordingDiarizer,
  RecordingDiarizerResult,
  RecordingTranscriptionAudio,
  RecordingWordAligner,
} from "@opengeni/core";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTail, trackRecordingProcesses } from "./recording-usage";

export type RecordingSpeakersConfig = {
  binaryPath: string;
  modelsDir: string;
  ffmpegPath: string;
  /** CPU threads; when omitted, speaker detection uses up to 4 and alignment every core. */
  threads?: number | undefined;
  tempRoot?: string | undefined;
};

export class RecordingSpeakersError extends Error {
  readonly name = "RecordingSpeakersError";
}

/** An hour of audio takes a few CPU-minutes; this only bounds a hang. */
const SPEAKERS_TIMEOUT_MS = 60 * 60 * 1_000;

type RawDiarization = {
  turns: Array<{ startMs: number; endMs: number; speaker: number }>;
  speakers: Array<{ speaker: number; speechMs: number; embedding: number[] }>;
};

/** The configured speaker models, or null when this worker has none. */
export function recordingSpeakersConfig(settings: {
  recordingSpeakersBinaryPath?: string | undefined;
  recordingSpeakerModelsDir?: string | undefined;
  voiceInputFfmpegPath: string;
}): RecordingSpeakersConfig | null {
  const binaryPath = settings.recordingSpeakersBinaryPath;
  const modelsDir = settings.recordingSpeakerModelsDir;
  if (!binaryPath || !modelsDir) return null;
  if (
    !existsSync(binaryPath) ||
    !existsSync(join(modelsDir, "segmentation.onnx")) ||
    !existsSync(join(modelsDir, "embedding.onnx"))
  ) {
    return null;
  }
  return { binaryPath, modelsDir, ffmpegPath: settings.voiceInputFfmpegPath };
}

/**
 * The aligner's model next to the speaker models, or null when the
 * deployment does not align words or this worker lacks the model.
 */
export function recordingAlignerConfig(settings: {
  recordingSpeakersBinaryPath?: string | undefined;
  recordingSpeakerModelsDir?: string | undefined;
  recordingWordAlignment?: boolean | undefined;
  voiceInputFfmpegPath: string;
}): RecordingSpeakersConfig | null {
  const binaryPath = settings.recordingSpeakersBinaryPath;
  const modelsDir = settings.recordingSpeakerModelsDir;
  if (!settings.recordingWordAlignment || !binaryPath || !modelsDir) return null;
  if (
    !existsSync(binaryPath) ||
    !existsSync(join(modelsDir, "alignment.onnx")) ||
    !existsSync(join(modelsDir, "alignment-tokens.txt"))
  ) {
    return null;
  }
  return { binaryPath, modelsDir, ffmpegPath: settings.voiceInputFfmpegPath };
}

/**
 * Decode `audio` with ffmpeg and pipe it into `opengeni-speakers <args>`.
 * `files` are written next to the audio; each adds `--flag path`.
 */
async function runSpeakers(
  config: RecordingSpeakersConfig,
  audio: RecordingTranscriptionAudio,
  args: string[],
  signal: AbortSignal | undefined,
  files: ReadonlyArray<{ flag: string; name: string; contents: string }> = [],
): Promise<string> {
  const directory = await mkdtemp(join(config.tempRoot ?? tmpdir(), "opengeni-speakers-"));
  try {
    for (const file of files) {
      const path = join(directory, file.name);
      await writeFile(path, file.contents);
      args = [...args, `--${file.flag}`, path];
    }
    // A file, not a pipe: MP4 audio keeps its index at the end.
    const input = join(directory, `audio.${audio.fileName.split(".").pop() || "bin"}`);
    await writeFile(input, audio.bytes);
    const decoder = Bun.spawn(
      [
        config.ffmpegPath,
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        input,
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        "16000",
        "pipe:1",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    let speakers: ReturnType<typeof spawnSpeakers>;
    try {
      speakers = spawnSpeakers(config, args, decoder.stdout);
    } catch (error) {
      decoder.kill("SIGKILL");
      throw error;
    }
    trackRecordingProcesses([decoder, speakers]);
    const kill = () => {
      decoder.kill("SIGKILL");
      speakers.kill("SIGKILL");
    };
    signal?.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, SPEAKERS_TIMEOUT_MS);
    try {
      const [decoderCode, code, stdout, speakersError, decoderError] = await Promise.all([
        decoder.exited,
        speakers.exited,
        new Response(speakers.stdout).text(),
        readTail(speakers.stderr, 8_192),
        readTail(decoder.stderr, 8_192),
      ]);
      if (code === 0 && decoderCode !== 0) {
        throw new RecordingSpeakersError(
          `ffmpeg could not decode the audio: ${decoderError.trim().slice(0, 400)}`,
        );
      }
      if (code === 0) return stdout;
      let message = speakersError.trim() || decoderError.trim() || `exit ${code}`;
      try {
        message = (JSON.parse(speakersError.trim().split("\n").pop() ?? "") as { error: string })
          .error;
      } catch {
        // Not the executable's JSON error line; keep the raw text.
      }
      throw new RecordingSpeakersError(`speaker models failed: ${message.slice(0, 400)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The speaker models, reading decoded audio from `stdin`. */
function spawnSpeakers(
  config: RecordingSpeakersConfig,
  args: string[],
  stdin: ReadableStream<Uint8Array>,
) {
  return Bun.spawn(
    [
      config.binaryPath,
      ...args,
      "--models",
      config.modelsDir,
      ...(config.threads ? ["--threads", String(config.threads)] : []),
    ],
    { stdin, stdout: "pipe", stderr: "pipe" },
  );
}

/** Parse the executable's diarization into turns and voices keyed `S0`, `S1`, … */
export function parseDiarization(json: string, voiceModel: string): RecordingDiarizerResult {
  const raw = JSON.parse(json) as RawDiarization;
  return {
    voiceModel,
    turns: raw.turns.map((turn) => ({
      startMilliseconds: turn.startMs,
      endMilliseconds: turn.endMs,
      speaker: `S${turn.speaker}`,
    })),
    voices: raw.speakers.map((speaker) => ({
      speaker: `S${speaker.speaker}`,
      speechMilliseconds: speaker.speechMs,
      embedding: speaker.embedding,
    })),
  };
}

/**
 * Names the voice vector space by the embedding model's bytes, so a model
 * swap never compares vectors from two different models.
 */
async function embeddingModelId(modelsDir: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(modelsDir, "embedding.onnx"))) {
    hash.update(chunk as Buffer);
  }
  return `opengeni-cpu:${hash.digest("hex").slice(0, 16)}`;
}

type RawAlignment = {
  words: Array<{ startMs: number; endMs: number; score?: number }>;
  anchoredWords: number;
  spreadWords: number;
  untimedWords: number;
};

/** Parse the executable's word placements. */
export function parseAlignment(json: string): RecordingAlignedWords {
  const raw = JSON.parse(json) as RawAlignment;
  return {
    words: raw.words.map((word) => ({
      startMilliseconds: word.startMs,
      endMilliseconds: word.endMs,
      score: typeof word.score === "number" ? word.score : null,
    })),
    anchoredWords: raw.anchoredWords,
    spreadWords: raw.spreadWords,
    untimedWords: raw.untimedWords,
  };
}

/** Our CPU aligner (Omnilingual ASR CTC, about 1,600 languages). */
export function createLocalAligner(config: RecordingSpeakersConfig): RecordingWordAligner {
  return {
    id: "opengeni-cpu",
    async align(audio, words, options) {
      if (words.length === 0) {
        return { words: [], anchoredWords: 0, spreadWords: 0, untimedWords: 0 };
      }
      const json = await runSpeakers(config, audio, ["align"], options.signal, [
        { flag: "words", name: "words.json", contents: JSON.stringify(words) },
      ]);
      return parseAlignment(json);
    },
  };
}

/** Our CPU diarizer. */
export function createLocalDiarizer(config: RecordingSpeakersConfig): RecordingDiarizer {
  let voiceModel: Promise<string> | null = null;
  return {
    id: "opengeni-cpu",
    async diarize(audio, options) {
      const json = await runSpeakers(
        config,
        audio,
        [
          "diarize",
          ...(options.maxSpeakers ? ["--max-speakers", String(options.maxSpeakers)] : []),
        ],
        options.signal,
      );
      voiceModel ??= embeddingModelId(config.modelsDir).catch((error: unknown) => {
        voiceModel = null;
        throw error;
      });
      return parseDiarization(json, await voiceModel);
    },
  };
}
