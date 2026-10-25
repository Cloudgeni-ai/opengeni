// Our own speaker models for meeting recordings: the `opengeni-speakers`
// executable (apps/worker/speakers, Rust on ONNX Runtime) tells speakers
// apart and embeds voices on the worker's CPU. ffmpeg decodes the track to
// 16 kHz mono float PCM and pipes it straight in, so no decoded copy of the
// audio is written to disk.

import type {
  RecordingDiarizer,
  RecordingDiarizerResult,
  RecordingTranscriptionAudio,
} from "@opengeni/core";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RecordingSpeakersConfig = {
  binaryPath: string;
  modelsDir: string;
  ffmpegPath: string;
  /** CPU threads; the executable uses every available core when omitted. */
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

/** Decode `audio` with ffmpeg and pipe it into `opengeni-speakers <args>`. */
async function runSpeakers(
  config: RecordingSpeakersConfig,
  audio: RecordingTranscriptionAudio,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  const directory = await mkdtemp(join(config.tempRoot ?? tmpdir(), "opengeni-speakers-"));
  try {
    // A file, not a pipe: MP4 audio keeps its index at the end.
    const input = join(directory, `audio.${audio.fileName.split(".").pop() || "bin"}`);
    await writeFile(input, audio.bytes);
    return await new Promise<string>((resolve, reject) => {
      const decoder = spawn(
        config.ffmpegPath,
        [
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
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const speakers = spawn(
        config.binaryPath,
        [
          ...args,
          "--models",
          config.modelsDir,
          ...(config.threads ? ["--threads", String(config.threads)] : []),
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      decoder.stdout.pipe(speakers.stdin);
      // The executable may exit early on an error; a closed pipe is not ours to report.
      speakers.stdin.on("error", () => undefined);
      let stdout = "";
      let speakersError = "";
      let decoderError = "";
      speakers.stdout.setEncoding("utf8");
      speakers.stdout.on("data", (data: string) => {
        stdout += data;
      });
      speakers.stderr.setEncoding("utf8");
      speakers.stderr.on("data", (data: string) => {
        speakersError = (speakersError + data).slice(-8_192);
      });
      decoder.stderr.setEncoding("utf8");
      decoder.stderr.on("data", (data: string) => {
        decoderError = (decoderError + data).slice(-8_192);
      });
      const kill = () => {
        decoder.kill("SIGKILL");
        speakers.kill("SIGKILL");
      };
      signal?.addEventListener("abort", kill, { once: true });
      const timer = setTimeout(kill, SPEAKERS_TIMEOUT_MS);
      let decoderCode: number | null = null;
      decoder.on("close", (code) => {
        decoderCode = code;
      });
      const settle = (error: Error | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        if (error) reject(error);
        else resolve(stdout);
      };
      decoder.on("error", (error) => {
        kill();
        settle(error);
      });
      speakers.on("error", (error) => {
        kill();
        settle(error);
      });
      speakers.on("close", (code) => {
        if (code === 0 && decoderCode !== null && decoderCode !== 0) {
          settle(
            new RecordingSpeakersError(
              `ffmpeg could not decode the audio: ${decoderError.trim().slice(0, 400)}`,
            ),
          );
        } else if (code === 0) {
          settle(null);
        } else {
          let message = speakersError.trim() || decoderError.trim() || `exit ${code}`;
          try {
            message = (
              JSON.parse(speakersError.trim().split("\n").pop() ?? "") as { error: string }
            ).error;
          } catch {
            // Not the executable's JSON error line; keep the raw text.
          }
          settle(new RecordingSpeakersError(`speaker models failed: ${message.slice(0, 400)}`));
        }
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
