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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECORDING_TIMELINE_FILTER } from "./recording-audio";
import {
  ALIGNER_BYTES,
  type MemoryBudget,
  speakerDetectionBytes,
  speakerMemory,
} from "./recording-memory";
import { readTail, stoppedBySignal, trackRecordingProcesses } from "./recording-usage";

export type RecordingSpeakersConfig = {
  binaryPath: string;
  modelsDir: string;
  ffmpegPath: string;
  /** CPU threads; when omitted, speaker detection uses up to 4 and alignment every core. */
  threads?: number | undefined;
  tempRoot?: string | undefined;
  /** Where the models' memory comes from: by default, this worker's share for them. */
  memory?: MemoryBudget | undefined;
  /** How long a loaded aligner waits for more words before it exits and frees its memory. */
  alignerIdleMilliseconds?: number | undefined;
};

export class RecordingSpeakersError extends Error {
  readonly name = "RecordingSpeakersError";
  constructor(
    message: string,
    /** Stopped from outside (the worker is stopping), not a failure of the models. */
    readonly interrupted = false,
  ) {
    super(message);
  }
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

/** ffmpeg decoding `input` to the models' 16 kHz mono float PCM on its stdout. */
function decoderCommand(config: RecordingSpeakersConfig, input: string): string[] {
  return [
    config.ffmpegPath,
    "-nostdin",
    "-loglevel",
    "error",
    "-i",
    input,
    // The track's own timeline, so turns and words line up with playback.
    "-af",
    RECORDING_TIMELINE_FILTER,
    "-f",
    "f32le",
    "-ac",
    "1",
    "-ar",
    "16000",
    "pipe:1",
  ];
}

/** Write `audio` to a new directory as a file, for `use`; both go after it. */
async function withAudioFile<T>(
  config: RecordingSpeakersConfig,
  audio: RecordingTranscriptionAudio,
  use: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(config.tempRoot ?? tmpdir(), "opengeni-speakers-"));
  try {
    // A file, not a pipe: MP4 audio keeps its index at the end.
    const path = join(directory, `audio.${audio.fileName.split(".").pop() || "bin"}`);
    await writeFile(path, audio.bytes);
    return await use(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  files: ReadonlyArray<{ flag: string; name: string; contents: string | Uint8Array }> = [],
  /** A file the executable writes, read back once it succeeds. */
  output?: { flag: string; name: string },
): Promise<{ stdout: string; output: Uint8Array | null }> {
  const directory = await mkdtemp(join(config.tempRoot ?? tmpdir(), "opengeni-speakers-"));
  try {
    for (const file of files) {
      const path = join(directory, file.name);
      await writeFile(path, file.contents);
      args = [...args, `--${file.flag}`, path];
    }
    const outputPath = output ? join(directory, output.name) : null;
    if (output && outputPath) args = [...args, `--${output.flag}`, outputPath];
    // A file, not a pipe: MP4 audio keeps its index at the end.
    const input = join(directory, `audio.${audio.fileName.split(".").pop() || "bin"}`);
    await writeFile(input, audio.bytes);
    const decoder = Bun.spawn(decoderCommand(config, input), {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
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
    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      kill();
    }, SPEAKERS_TIMEOUT_MS);
    try {
      const [decoderCode, code, stdout, speakersError, decoderError] = await Promise.all([
        decoder.exited,
        speakers.exited,
        new Response(speakers.stdout).text(),
        readTail(speakers.stderr, 8_192),
        readTail(decoder.stderr, 8_192),
      ]);
      if (
        !hung &&
        (code !== 0 || decoderCode !== 0) &&
        (signal?.aborted ||
          stoppedBySignal(speakers, speakersError) ||
          stoppedBySignal(decoder, decoderError))
      ) {
        throw new RecordingSpeakersError("speaker detection was stopped", true);
      }
      if (code === 0 && decoderCode !== 0) {
        throw new RecordingSpeakersError(
          `ffmpeg could not decode the audio: ${decoderError.trim().slice(0, 400)}`,
        );
      }
      if (code === 0) {
        return {
          stdout,
          output: outputPath ? new Uint8Array(await readFile(outputPath)) : null,
        };
      }
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
  const server = createAlignerServer(config);
  return {
    id: "opengeni-cpu",
    async align(audio, words, options) {
      if (words.length === 0) {
        return { words: [], anchoredWords: 0, spreadWords: 0, untimedWords: 0 };
      }
      return await withAudioFile(config, audio, (path) =>
        server.align(words, decoderCommand(config, path), options.signal),
      );
    },
  };
}

/** How long a loaded aligner waits for more words before it exits. */
const ALIGNER_IDLE_MILLISECONDS = 60_000;

/** The most copies of the aligner's model one worker loads. */
const ALIGNER_COPIES_MAX = 4;

type AlignerProcess = {
  child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  waiting: Map<
    number,
    { resolve: (words: RecordingAlignedWords) => void; reject: (error: Error) => void }
  >;
  idle: ReturnType<typeof setTimeout> | null;
  /** Stops listening for other jobs wanting its memory while it is idle. */
  unwatch: (() => void) | null;
  /** It takes no more pieces: it is exiting or has exited. */
  retired: boolean;
  /** Gives back the memory set aside for copies it didn't load. */
  loaded: (sessions: number) => void;
};

/**
 * One `opengeni-speakers align-serve` for every alignment on this worker:
 * the model is loaded once (about 0.8 GB a copy, and only as many copies as
 * memory allows) and aligns the pieces of every meeting from there, instead
 * of a copy for each piece. It starts with the first piece and exits once it
 * has had none for a minute, giving its memory back, or at once when it is
 * idle and speaker detection is waiting for that memory.
 */
function createAlignerServer(config: RecordingSpeakersConfig) {
  const memory = config.memory ?? speakerMemory;
  const idleMilliseconds = config.alignerIdleMilliseconds ?? ALIGNER_IDLE_MILLISECONDS;
  let current: Promise<AlignerProcess> | null = null;
  /** The process `current` resolved to, while it still takes pieces. */
  let running: AlignerProcess | null = null;
  let nextId = 0;

  /** The running process stops taking pieces; the next piece starts another. */
  const forget = (process: AlignerProcess) => {
    process.retired = true;
    if (running === process) {
      running = null;
      current = null;
    }
  };

  const start = async (): Promise<AlignerProcess> => {
    // One copy of the model, and more where memory is plentiful (each
    // aligns a piece of its own, so a large machine aligns more at once),
    // always leaving room for speaker detection beside them.
    const holds = [await memory.take(ALIGNER_BYTES)];
    while (
      holds.length < ALIGNER_COPIES_MAX &&
      memory.totalBytes - memory.outBytes >= ALIGNER_BYTES + speakerDetectionBytes(undefined)
    ) {
      const more = memory.takeIfFree(ALIGNER_BYTES);
      if (!more) break;
      holds.push(more);
    }
    const release = () => {
      for (const hold of holds.splice(0)) hold();
    };
    let child: AlignerProcess["child"];
    try {
      child = Bun.spawn(
        [
          config.binaryPath,
          "align-serve",
          "--models",
          config.modelsDir,
          "--sessions",
          String(holds.length),
          ...(config.threads ? ["--threads", String(config.threads)] : []),
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
    } catch (error) {
      release();
      throw error;
    }
    const process: AlignerProcess = {
      child,
      waiting: new Map(),
      idle: null,
      unwatch: null,
      retired: false,
      // It loads fewer copies than it may on a machine with few cores.
      loaded: (sessions) => {
        for (const hold of holds.splice(Math.max(1, sessions))) hold();
      },
    };
    const stderr = readTail(child.stderr, 8_192);
    void readLines(child.stdout, (line) => answer(process, line));
    void child.exited.then(async () => {
      release();
      settle(process);
      forget(process);
      if (process.waiting.size === 0) return;
      const tail = (await stderr).trim();
      const error = stoppedBySignal(child, tail)
        ? new RecordingSpeakersError("the aligner was stopped", true)
        : new RecordingSpeakersError(`the aligner stopped: ${lastError(tail).slice(0, 400)}`);
      for (const entry of process.waiting.values()) entry.reject(error);
      process.waiting.clear();
    });
    running = process;
    return process;
  };

  /** It has work again, or has exited: no more idle exit. */
  const settle = (process: AlignerProcess) => {
    if (process.idle) clearTimeout(process.idle);
    process.idle = null;
    process.unwatch?.();
    process.unwatch = null;
  };

  /** Asked nothing more, it finishes and exits; a later piece starts another. */
  const retire = (process: AlignerProcess) => {
    if (process.waiting.size > 0) return;
    settle(process);
    forget(process);
    void process.child.stdin.end();
  };

  const answer = (process: AlignerProcess, line: string) => {
    let message: { id?: unknown; error?: unknown; ready?: unknown; sessions?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.ready === true && typeof message.sessions === "number") {
      process.loaded(message.sessions);
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = process.waiting.get(message.id);
    if (!entry) return;
    process.waiting.delete(message.id);
    if (typeof message.error === "string") {
      entry.reject(
        new RecordingSpeakersError(`speaker models failed: ${message.error.slice(0, 400)}`),
      );
    } else {
      try {
        entry.resolve(parseAlignment(line));
      } catch (error) {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (process.waiting.size === 0) {
      if (memory.wanted) {
        retire(process);
        return;
      }
      process.idle = setTimeout(() => retire(process), idleMilliseconds);
      process.unwatch = memory.whenWanted(() => retire(process));
    }
  };

  return {
    async align(
      words: readonly string[],
      decode: string[],
      signal: AbortSignal | undefined,
    ): Promise<RecordingAlignedWords> {
      signal?.throwIfAborted();
      let process: AlignerProcess;
      do {
        current ??= start().catch((error: unknown) => {
          current = null;
          throw error;
        });
        process = await current;
        // It may have exited, or been retired, while this piece waited for it.
      } while (process.retired);
      settle(process);
      const id = (nextId += 1);
      const result = new Promise<RecordingAlignedWords>((resolve, reject) => {
        process.waiting.set(id, { resolve, reject });
      });
      try {
        process.child.stdin.write(`${JSON.stringify({ id, words, decode })}\n`);
        void process.child.stdin.flush();
      } catch (error) {
        // It exited just now; its exit fails what it was still asked.
        process.waiting.delete(id);
        throw new RecordingSpeakersError(`the aligner stopped: ${String(error)}`);
      }
      if (!signal) return await result;
      // Stopped from outside: the answer is no longer wanted. The piece still
      // finishes in the aligner, which then goes on with the next.
      const stopped = new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new RecordingSpeakersError("the aligner was stopped", true)),
          { once: true },
        );
      });
      return await Promise.race([result, stopped]);
    },
  };
}

/** Call `each` with every line of `stream`. */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  each: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) each(line);
    }
  }
}

/** The executable's own error from its last stderr line, else the raw text. */
function lastError(stderr: string): string {
  try {
    return (JSON.parse(stderr.split("\n").pop() ?? "") as { error: string }).error;
  } catch {
    return stderr || "no output";
  }
}

/** Our CPU diarizer. */
export function createLocalDiarizer(config: RecordingSpeakersConfig): RecordingDiarizer {
  // Each run waits for its share of the worker's memory, so a meeting's
  // tracks run side by side where there is room and one after another where
  // there isn't.
  const memory = config.memory ?? speakerMemory;
  let voiceModel: Promise<string> | null = null;
  return {
    id: "opengeni-cpu",
    async diarize(audio, options) {
      const release = await memory.take(
        speakerDetectionBytes(options.durationMilliseconds),
        options.signal,
      );
      const { stdout } = await runSpeakers(
        config,
        audio,
        [
          "diarize",
          ...(options.speakers
            ? [
                "--min-speakers",
                String(options.speakers),
                "--max-speakers",
                String(options.speakers),
              ]
            : options.maxSpeakers
              ? ["--max-speakers", String(options.maxSpeakers)]
              : []),
        ],
        options.signal,
        // Windows scanned while the meeting was recorded are not scanned again.
        options.cache ? [{ flag: "cache-in", name: "windows.bin", contents: options.cache }] : [],
      ).finally(release);
      voiceModel ??= embeddingModelId(config.modelsDir).catch((error: unknown) => {
        voiceModel = null;
        throw error;
      });
      return parseDiarization(stdout, await voiceModel);
    },
    async scan(audio, options) {
      const release = await memory.take(
        speakerDetectionBytes(options.durationMilliseconds),
        options.signal,
      );
      const { output } = await runSpeakers(
        config,
        audio,
        ["diarize", "--scan-only", "true"],
        options.signal,
        options.cache ? [{ flag: "cache-in", name: "windows.bin", contents: options.cache }] : [],
        { flag: "cache-out", name: "windows-out.bin" },
      ).finally(release);
      if (!output) throw new RecordingSpeakersError("speaker detection kept no windows");
      return output;
    },
  };
}
