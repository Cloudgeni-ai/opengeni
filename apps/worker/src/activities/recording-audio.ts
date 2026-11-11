import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileSink } from "bun";
import {
  RECORDING_MAX_DURATION_MILLISECONDS,
  recordingAudioContainer,
  type RecordingAudioContainer,
} from "@opengeni/contracts";
import { pcmWavPiece, readPcmWav } from "./dictation-pieces";
import { readTail, stoppedBySignal, trackRecordingProcesses } from "./recording-usage";

export { recordingAudioContainer, type RecordingAudioContainer };

/**
 * Decode audio on its container timeline. A capture can leave holes in its
 * timestamps (a desktop's system audio did: 436 holes, 33 s in under
 * 8 minutes; a browser track fed by an audio graph that stops or is
 * suspended leaves one as long as the quiet). A plain decode closes them up,
 * so everything timed on the decoded audio (words, speaker turns, pieces)
 * runs early against the player. This fills each hole with silence instead,
 * from time zero.
 *
 * The filter fills a hole in one go and holds that stretch of silence in
 * memory, so it is only used on files the worker prepared itself, whose holes
 * are already filled. Uploaded audio is put on its timeline by
 * `prepareRecordingTrackAudio`, which makes the same corrections while it
 * streams, writing silence in fixed-size pieces.
 */
export const RECORDING_TIMELINE_FILTER = "aresample=async=1:first_pts=0";

/**
 * The longest audio accepted for a declared duration.
 *
 * A browser's MediaRecorder stamps its packets on the same monotonic clock
 * the recorder measures chunk durations on, so its timeline follows what
 * it declared however it went quiet: captures with 130 s of silence, a
 * 130 s pause or a 130 s hole in their timestamps all ended within 0.15 s of
 * what they declared, all but one short of it. A phone counts its
 * durations in the samples it encoded. Only a capture timed by its samples
 * against a declared wall-clock length, such as the desktop app's audio of
 * other apps, can run longer: by its audio device's clock error, a fraction
 * of a percent on real hardware, plus what the platform still had buffered
 * after the app last padded a stall with silence, which is seconds at most
 * and does not add up over stalls. Five seconds and 1% leave a wide margin
 * over both.
 *
 * A run that declared no length, such as a file brought in whose length the
 * app could not read, may be as long as a recording can be.
 */
export function recordingDurationLimitMilliseconds(declaredMilliseconds: number): number {
  const declared =
    declaredMilliseconds > 0 ? declaredMilliseconds : RECORDING_MAX_DURATION_MILLISECONDS;
  return Math.ceil(declared + 5_000 + declared / 100);
}

/**
 * Turning a track's uploaded chunks into one seekable audio file.
 *
 * A browser MediaRecorder writes one container header and then appends
 * clusters, so the chunks of one capture session concatenate into a valid
 * file. A reload, a crash or a device switch starts a new session with a new
 * header. Each session becomes one "run"; runs are placed on the recording's
 * timeline by their first chunk's start time.
 *
 * A chunk boundary can fall inside a header: Chromium sometimes hands out the
 * first byte of a session on its own when no audio has arrived yet. A chunk
 * too short to tell is held and judged together with the chunks after it.
 *
 * A phone writes an ADTS AAC stream: every frame carries its own header, so
 * any chunk concatenates onto the one before. There a run ends where the
 * timeline jumps (a capture that started again after the app was stopped).
 */

export type RecordingAudioChunk = {
  chunkNumber: number;
  startMilliseconds: number;
  durationMilliseconds: number;
  objectKey: string;
};

/** Whether a chunk begins a new container: an EBML, MP4 `ftyp` or Ogg header. */
export function startsContainer(bytes: Uint8Array): boolean {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return true;
  }
  if (
    bytes.length >= 8 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return true;
  }
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53 &&
    // An Ogg page that begins a stream carries the BOS flag.
    bytes.length >= 6 &&
    (bytes[5]! & 0x02) === 0x02
  );
}

/** Whether bytes begin with an ADTS frame header (12-bit sync, layer 0). */
export function startsAdtsFrame(bytes: Uint8Array): boolean {
  return bytes.length >= 7 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0;
}

/** Bytes `startsContainer` needs to recognise every header it knows. */
const CONTAINER_HEADER_BYTES = 8;
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;
const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53] as const;

/**
 * Whether bytes too short to judge may be the start of a container header
 * that the next chunk completes. Before any run, anything may be (an MP4 box
 * starts with its size); within a run only bytes that begin like an EBML or
 * Ogg header may be.
 */
function mayStartContainer(bytes: Uint8Array, inRun: boolean): boolean {
  if (bytes.length >= CONTAINER_HEADER_BYTES || startsContainer(bytes)) return false;
  if (!inRun) return true;
  const beginsLike = (magic: readonly number[]) =>
    bytes.every((byte, index) => index >= magic.length || byte === magic[index]);
  return beginsLike(EBML_MAGIC) || beginsLike(OGG_MAGIC);
}

function joined(left: Uint8Array, right: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(left.length + right.length);
  bytes.set(left, 0);
  bytes.set(right, left.length);
  return bytes;
}

/** How far an ADTS chunk may start from where the one before ended and still continue it. */
const ADTS_CONTINUITY_MILLISECONDS = 1_000;

/** Whether a chunk starts a new run: a container header, or for ADTS a jump in the timeline. */
function startsRun(
  container: RecordingAudioContainer,
  bytes: Uint8Array,
  previous: RecordingAudioChunk | null,
  chunk: RecordingAudioChunk,
): boolean {
  if (container !== "aac") return startsContainer(bytes);
  if (!previous) return true;
  const expected = previous.startMilliseconds + previous.durationMilliseconds;
  return Math.abs(chunk.startMilliseconds - expected) > ADTS_CONTINUITY_MILLISECONDS;
}

export type PreparedAudioFormat = {
  extension: string;
  mimeType: string;
  muxer: string;
  codec: string;
  /** Encoder arguments after the codec. */
  encoderArgs: readonly string[];
};

/**
 * How a meeting's audio is kept: one file per track, Opus at 16 kbit/s
 * mono, tuned for speech. That is about 7 MB an hour, and speech models
 * and our speaker models (which run at 16 kHz) hear it as well as the
 * uploaded pieces. It is in MP4, which every browser and both phone
 * platforms play and seek without loading the whole file.
 */
export const ARCHIVAL_AUDIO_FORMAT: PreparedAudioFormat = {
  extension: "m4a",
  mimeType: "audio/mp4",
  muxer: "mp4",
  codec: "libopus",
  encoderArgs: ["-b:a", "16k", "-application", "voip", "-ac", "1", "-movflags", "+faststart"],
};

/**
 * The audio a transcript is made from: 16 kHz mono 16-bit PCM, what speech
 * models and our speaker models run at. Decoding a track to it takes
 * seconds even for an hour, where encoding the compact kept copy takes most
 * of a minute, and its pieces are cut from the samples themselves.
 */
export const SPEECH_PCM_FORMAT: PreparedAudioFormat = {
  extension: "wav",
  mimeType: "audio/wav",
  muxer: "wav",
  codec: "pcm_s16le",
  encoderArgs: ["-ar", "16000", "-ac", "1"],
};

/**
 * The prepared file's format for a source container when it is only used
 * once and not kept (a dictation): the source's own codec, so the models
 * that take it as it is still can.
 */
export function preparedAudioFormat(container: RecordingAudioContainer): PreparedAudioFormat {
  // MP4 (Safari) and ADTS (phones) sources are AAC; everything else is Opus.
  return container === "mp4" || container === "aac"
    ? {
        extension: "m4a",
        mimeType: "audio/mp4",
        muxer: "ipod",
        codec: "aac",
        encoderArgs: ["-b:a", "64k"],
      }
    : {
        extension: "webm",
        mimeType: "audio/webm",
        muxer: "webm",
        codec: "libopus",
        encoderArgs: ["-b:a", "32k"],
      };
}

export class RecordingAudioError extends Error {
  readonly name = "RecordingAudioError";
  constructor(
    message: string,
    /** `interrupted`: ffmpeg was stopped from outside, so the step is retried. */
    readonly code: "invalid_audio" | "missing_chunk" | "ffmpeg_failed" | "interrupted",
  ) {
    super(message);
  }
}

const FFMPEG_TIMEOUT_MS = 30 * 60 * 1_000;

type FfmpegStreams = {
  /** Reads ffmpeg's output as it is written; throwing stops ffmpeg with that error. */
  stdout?: (stdout: ReadableStream<Uint8Array>) => Promise<void>;
  /**
   * Writes ffmpeg's input, which ends when this settles. When it throws,
   * ffmpeg's own failure is reported if it has one, otherwise that error.
   */
  stdin?: (stdin: FileSink) => Promise<void>;
};

async function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  signal?: AbortSignal,
  stderrBytes = 16_384,
  streams: FfmpegStreams = {},
): Promise<{ stderr: string }> {
  const child = Bun.spawn([ffmpegPath, ...args], {
    stdin: streams.stdin ? "pipe" : "ignore",
    stdout: streams.stdout ? "pipe" : "ignore",
    stderr: "pipe",
  });
  trackRecordingProcesses([child]);
  const abort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    abort();
  }, FFMPEG_TIMEOUT_MS);
  let writeFailure: { error: unknown } | null = null;
  const writing = streams.stdin
    ? (async () => {
        const sink = child.stdin as FileSink;
        try {
          await streams.stdin!(sink);
        } catch (error) {
          writeFailure = { error };
        }
        try {
          await sink.end();
        } catch {
          // ffmpeg already closed its input.
        }
      })()
    : undefined;
  try {
    const [code, stderr] = await Promise.all([
      child.exited,
      readTail(child.stderr, stderrBytes),
      streams.stdout?.(child.stdout as ReadableStream<Uint8Array>).catch((error: unknown) => {
        abort();
        throw error;
      }),
      writing,
    ]);
    if (code === 0) {
      // ffmpeg finished what it was given, but its input was cut short.
      if (writeFailure) throw (writeFailure as { error: unknown }).error;
      return { stderr };
    }
    const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400) || `exit ${code}`;
    if (hung) {
      throw new RecordingAudioError(`ffmpeg hung preparing the audio: ${detail}`, "ffmpeg_failed");
    }
    if (signal?.aborted || stoppedBySignal(child, stderr)) {
      throw new RecordingAudioError(`ffmpeg was stopped: ${detail}`, "interrupted");
    }
    throw new RecordingAudioError(`ffmpeg could not prepare the audio: ${detail}`, "ffmpeg_failed");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** The last `time=` ffmpeg reports, which is the written file's length. */
export function ffmpegReportedMilliseconds(stderr: string): number | null {
  const matches = [...stderr.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/gu)];
  const last = matches.at(-1);
  if (!last) return null;
  return Math.round((Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1_000);
}

/**
 * The PCM the worker streams between ffmpeg processes while it puts a run on
 * its timeline: 16-bit little-endian mono at 48 kHz, as runs were mixed at.
 */
const TIMELINE_SAMPLE_RATE = 48_000;
const TIMELINE_BYTES_PER_SAMPLE = 2;
const TIMELINE_PCM_ARGS = ["-f", "s16le", "-ar", String(TIMELINE_SAMPLE_RATE), "-ac", "1"];

/**
 * How far a run's audio may drift from its timestamps before it is put back
 * on them, as `RECORDING_TIMELINE_FILTER` does: from time zero to the first
 * packet, and between packets after it.
 */
const TIMELINE_FIRST_DRIFT_MILLISECONDS = 1;
const TIMELINE_DRIFT_MILLISECONDS = 100;

/** Silence is written in pieces of this size, so a hole of any length takes the same memory. */
const SILENCE = new Uint8Array(64 * 1_024);

/**
 * Where a run's decoded audio is put back on its timestamps: at a byte of the
 * decoded PCM, a number of bytes of silence put in (positive) or of audio
 * left out (negative). Every change is at least the drift the timeline
 * allows, and the timeline is bounded, so there are few of them.
 */
type RunTimeline = { at: number[]; bytes: number[] };

function timelineBytes(milliseconds: number): number {
  return Math.round((milliseconds * TIMELINE_SAMPLE_RATE) / 1_000) * TIMELINE_BYTES_PER_SAMPLE;
}

/**
 * Read a run's packet timestamps without decoding it, and work out where its
 * decoded audio must be moved to stay on them: a hole (from time zero to the
 * first packet, or between packets) is filled with silence, and audio that
 * overlaps what came before is left out. A run whose timeline, or the audio
 * its packets hold, runs past the length its chunks declared is refused
 * before anything is decoded. Packets are read as ffmpeg writes them, and
 * the first one out of bounds stops it.
 */
async function scanRunTimeline(
  ffmpegPath: string,
  path: string,
  declaredMilliseconds: number,
  signal?: AbortSignal,
): Promise<RunTimeline> {
  const limit = recordingDurationLimitMilliseconds(declaredMilliseconds);
  const timeline: RunTimeline = { at: [], bytes: [] };
  let millisecondsPerTick: number | null = null;
  // The audio decoded so far, and where its end sits on the timeline.
  let decoded = 0;
  let placed = 0;
  let first = true;
  const packet = (line: string) => {
    const timebase = /^#tb 0: (\d+)\/(\d+)$/u.exec(line);
    if (timebase) {
      millisecondsPerTick = (Number(timebase[1]) * 1_000) / Number(timebase[2]);
      return;
    }
    if (line === "" || line.startsWith("#")) return;
    // framecrc: stream index, dts, pts, duration, size, checksum.
    const [, , pts, duration] = line.split(",").map((field) => Number(field.trim()));
    if (millisecondsPerTick === null || !Number.isFinite(millisecondsPerTick)) {
      throw new RecordingAudioError("ffmpeg did not report the audio's time base", "ffmpeg_failed");
    }
    if (pts === undefined || !Number.isFinite(pts)) return;
    const start = pts * millisecondsPerTick;
    const drift = start - placed;
    if (
      Math.abs(drift) > (first ? TIMELINE_FIRST_DRIFT_MILLISECONDS : TIMELINE_DRIFT_MILLISECONDS)
    ) {
      const bytes = timelineBytes(start) - timelineBytes(placed);
      if (bytes !== 0) {
        timeline.at.push(timelineBytes(decoded));
        timeline.bytes.push(bytes);
      }
      placed = start;
    }
    first = false;
    const length = duration !== undefined && duration > 0 ? duration * millisecondsPerTick : 0;
    decoded += length;
    placed += length;
    if (placed > limit || decoded > limit) {
      throw new RecordingAudioError("The audio runs past its declared length", "invalid_audio");
    }
  };
  await runFfmpeg(
    ffmpegPath,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      // The container's own timestamps, not shifted to start at zero.
      "-copyts",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-c",
      "copy",
      "-f",
      "framecrc",
      "-",
    ],
    signal,
    16_384,
    {
      stdout: async (stdout) => {
        const decoder = new TextDecoder();
        let rest = "";
        for await (const bytes of stdout) {
          const lines = (rest + decoder.decode(bytes, { stream: true })).split("\n");
          rest = lines.pop() ?? "";
          for (const line of lines) packet(line.trim());
        }
        packet((rest + decoder.decode()).trim());
      },
    },
  );
  return timeline;
}

function* silent(bytes: number): Generator<Uint8Array> {
  for (let left = bytes; left > 0; left -= SILENCE.byteLength) {
    yield SILENCE.subarray(0, Math.min(left, SILENCE.byteLength));
  }
}

/** Decoded PCM with a run's timeline changes made as it streams past. */
async function* onTimeline(
  pcm: AsyncIterable<Uint8Array>,
  timeline: RunTimeline,
): AsyncGenerator<Uint8Array> {
  let position = 0;
  let next = 0;
  let dropping = 0;
  const due = function* () {
    while (next < timeline.at.length && timeline.at[next]! <= position) {
      const bytes = timeline.bytes[next]!;
      next += 1;
      if (bytes > 0) yield* silent(bytes);
      else dropping -= bytes;
    }
  };
  for await (const piece of pcm) {
    let offset = 0;
    while (offset < piece.byteLength) {
      yield* due();
      const until = next < timeline.at.length ? timeline.at[next]! : Number.POSITIVE_INFINITY;
      const take = Math.min(piece.byteLength - offset, until - position);
      const dropped = Math.min(dropping, take);
      dropping -= dropped;
      if (take > dropped) yield piece.subarray(offset + dropped, offset + take);
      offset += take;
      position += take;
    }
  }
  // Holes after the last decoded audio: the decoder gave less than the packets said.
  for (; next < timeline.at.length; next += 1) {
    if (timeline.bytes[next]! > 0) yield* silent(timeline.bytes[next]!);
  }
}

const STOPPED_READING = new Error("The decoded audio was no longer needed");

/**
 * Decode one run and put it on its timeline as it streams, in
 * `TIMELINE_PCM_ARGS`. ffmpeg decodes it plainly, holes closed up, and the
 * timeline's changes are made on the way past: however long a hole is, it
 * takes no more memory than any other stretch.
 */
async function* decodeRunOnTimeline(
  ffmpegPath: string,
  path: string,
  timeline: RunTimeline,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let handOut!: (stdout: ReadableStream<Uint8Array>) => void;
  let release!: (stopped?: Error) => void;
  const output = new Promise<ReadableStream<Uint8Array>>((resolve) => {
    handOut = resolve;
  });
  const released = new Promise<void>((resolve, reject) => {
    release = (stopped) => (stopped ? reject(stopped) : resolve());
  });
  const decoding = runFfmpeg(
    ffmpegPath,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path,
      "-vn",
      "-map",
      "0:a:0",
      ...TIMELINE_PCM_ARGS,
      "-",
    ],
    signal,
    16_384,
    {
      stdout: async (stdout) => {
        handOut(stdout);
        await released;
      },
    },
  );
  // Observed when the run is done; a decoder that never starts is reported here.
  const started = Promise.race([
    output,
    decoding.then(() => {
      throw new RecordingAudioError("ffmpeg gave no decoded audio", "ffmpeg_failed");
    }),
  ]);
  let complete = false;
  try {
    yield* onTimeline(await started, timeline);
    complete = true;
  } finally {
    if (complete) {
      release();
      await decoding;
    } else {
      release(STOPPED_READING);
      await decoding.catch(() => undefined);
    }
  }
}

/**
 * Runs placed at their offsets (in bytes of `TIMELINE_PCM_ARGS`) and summed
 * where they overlap, as one stream. A run is decoded only once the mix
 * reaches it, and the gaps before runs are written as silence in pieces.
 */
async function* mixRuns(
  runs: ReadonlyArray<{ offset: number; pcm: () => AsyncGenerator<Uint8Array> }>,
): AsyncGenerator<Uint8Array> {
  const ordered = [...runs].sort((left, right) => left.offset - right.offset);
  if (ordered.length === 1 && ordered[0]!.offset === 0) {
    yield* ordered[0]!.pcm();
    return;
  }
  // A second at a time; runs are summed sample by sample.
  const blockBytes = TIMELINE_SAMPLE_RATE * TIMELINE_BYTES_PER_SAMPLE;
  type Playing = {
    pcm: AsyncGenerator<Uint8Array>;
    position: number;
    piece: Uint8Array;
    offset: number;
    done: boolean;
  };
  let playing: Playing[] = [];
  let next = 0;
  let position = 0;
  const scratch = new Uint8Array(blockBytes);
  try {
    for (;;) {
      while (next < ordered.length && ordered[next]!.offset < position + blockBytes) {
        const run = ordered[next]!;
        playing.push({
          pcm: run.pcm(),
          position: Math.max(position, run.offset),
          piece: new Uint8Array(0),
          offset: 0,
          done: false,
        });
        next += 1;
      }
      if (playing.length === 0) {
        if (next >= ordered.length) return;
        yield* silent(ordered[next]!.offset - position);
        position = ordered[next]!.offset;
        continue;
      }
      const end = position + blockBytes;
      const block = new Uint8Array(blockBytes);
      const mixed = new Int16Array(block.buffer);
      const adding = new Int16Array(scratch.buffer);
      let reached = position;
      for (const [index, run] of playing.entries()) {
        // The first run is written as it is; the others are added to it.
        const target = index === 0 ? block : scratch;
        if (index > 0) scratch.fill(0);
        const from = run.position - position;
        while (run.position < end && !run.done) {
          if (run.offset >= run.piece.byteLength) {
            const read = await run.pcm.next();
            if (read.done) run.done = true;
            else {
              run.piece = read.value;
              run.offset = 0;
            }
            continue;
          }
          const take = Math.min(run.piece.byteLength - run.offset, end - run.position);
          target.set(run.piece.subarray(run.offset, run.offset + take), run.position - position);
          run.offset += take;
          run.position += take;
        }
        if (index > 0) {
          const last = Math.ceil((run.position - position) / TIMELINE_BYTES_PER_SAMPLE);
          for (let sample = Math.floor(from / TIMELINE_BYTES_PER_SAMPLE); sample < last; sample++) {
            mixed[sample] = Math.max(-32_768, Math.min(32_767, mixed[sample]! + adding[sample]!));
          }
        }
        reached = Math.max(reached, run.position);
      }
      playing = playing.filter((run) => !run.done);
      if (reached > position) {
        yield block.subarray(0, reached - position);
        position = reached;
      }
    }
  } finally {
    for (const run of playing) await run.pcm.return(undefined);
  }
}

export type PreparedRecordingAudio = {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  durationMilliseconds: number;
  /** Where the file starts on the recording timeline. */
  offsetMilliseconds: number;
};

/** How many chunk downloads run ahead of the one being written. */
export const CHUNK_READ_CONCURRENCY = 16;

/**
 * Read chunks in order while keeping up to `concurrency` downloads in flight,
 * so a track of many small objects costs a few round trips, not one per chunk.
 */
export async function* readChunksInOrder<Chunk>(
  chunks: readonly Chunk[],
  read: (chunk: Chunk) => Promise<Uint8Array | null>,
  concurrency: number = CHUNK_READ_CONCURRENCY,
): AsyncGenerator<{ chunk: Chunk; bytes: Uint8Array | null }> {
  const pending: Array<Promise<Uint8Array | null>> = [];
  let next = 0;
  const fill = () => {
    while (next < chunks.length && pending.length < Math.max(1, concurrency)) {
      const reading = read(chunks[next]!);
      // A read left behind by an early stop must not surface as unhandled.
      reading.catch(() => undefined);
      pending.push(reading);
      next += 1;
    }
  };
  fill();
  for (let index = 0; index < chunks.length; index += 1) {
    const bytes = await pending.shift()!;
    fill();
    yield { chunk: chunks[index]!, bytes };
  }
}

/**
 * Download a track's chunks, split them into runs and write one seekable
 * file. One run is remuxed with its codec copied; several runs are decoded,
 * delayed to their start times and encoded once, so gaps become silence.
 */
export async function prepareRecordingTrackAudio(input: {
  chunks: readonly RecordingAudioChunk[];
  mimeType: string;
  readChunk: (chunk: RecordingAudioChunk) => Promise<Uint8Array | null>;
  ffmpegPath: string;
  /** The file to write; defaults to the source's own codec (`preparedAudioFormat`). */
  format?: PreparedAudioFormat | undefined;
  tempRoot?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: (() => void) | undefined;
}): Promise<PreparedRecordingAudio> {
  const container = recordingAudioContainer(input.mimeType);
  if (!container) {
    throw new RecordingAudioError(`Unsupported audio type ${input.mimeType}`, "invalid_audio");
  }
  const format = input.format ?? preparedAudioFormat(container);
  const ordered = [...input.chunks].sort((left, right) => left.chunkNumber - right.chunkNumber);
  if (ordered.length === 0)
    throw new RecordingAudioError("The track has no audio", "invalid_audio");
  const directory = await mkdtemp(join(input.tempRoot ?? tmpdir(), "opengeni-recording-"));
  try {
    /** Each run's place on the timeline, from the starts and durations its chunks declared. */
    const runs: Array<{ startMilliseconds: number; endMilliseconds: number; path: string }> = [];
    const extendRun = (through: RecordingAudioChunk) => {
      const run = runs.at(-1)!;
      run.endMilliseconds = Math.max(
        run.endMilliseconds,
        through.startMilliseconds + through.durationMilliseconds,
      );
    };
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let previous: RecordingAudioChunk | null = null;
    // Short bytes held until the chunks after them show whether a header starts there.
    let held: { bytes: Uint8Array; chunk: RecordingAudioChunk } | null = null;
    try {
      for await (const { chunk, bytes: read } of readChunksInOrder(ordered, async (next) => {
        input.signal?.throwIfAborted();
        return input.readChunk(next);
      })) {
        input.signal?.throwIfAborted();
        if (!read) {
          throw new RecordingAudioError(`Chunk ${chunk.chunkNumber} is missing`, "missing_chunk");
        }
        // Held bytes start where their own chunk did.
        const first: RecordingAudioChunk = held?.chunk ?? chunk;
        const bytes: Uint8Array = held ? joined(held.bytes, read) : read;
        held = null;
        if (container !== "aac" && mayStartContainer(bytes, handle !== null)) {
          held = { bytes, chunk: first };
          previous = chunk;
          input.onProgress?.();
          continue;
        }
        if (!handle || startsRun(container, bytes, previous, first)) {
          const header = container === "aac" ? startsAdtsFrame(bytes) : startsContainer(bytes);
          if (!header) {
            throw new RecordingAudioError(
              container === "aac"
                ? `Chunk ${first.chunkNumber} does not start with an AAC frame`
                : "The first chunk of the track has no container header",
              "invalid_audio",
            );
          }
          await handle?.close();
          const path = join(directory, `run-${runs.length}.${container}`);
          handle = await open(path, "wx", 0o600);
          runs.push({
            startMilliseconds: first.startMilliseconds,
            endMilliseconds: first.startMilliseconds,
            path,
          });
        }
        await handle.write(bytes);
        extendRun(first);
        extendRun(chunk);
        previous = chunk;
        input.onProgress?.();
      }
      // The track ended on short bytes: the tail of its last run.
      if (held) {
        if (!handle) {
          throw new RecordingAudioError(
            "The first chunk of the track has no container header",
            "invalid_audio",
          );
        }
        await handle.write(held.bytes);
        extendRun(held.chunk);
        if (previous) extendRun(previous);
      }
    } finally {
      await handle?.close();
    }
    // Every run's timestamps are read, and checked against what it declared, before any is decoded.
    const timelines: RunTimeline[] = [];
    for (const run of runs) {
      timelines.push(
        await scanRunTimeline(
          input.ffmpegPath,
          run.path,
          run.endMilliseconds - run.startMilliseconds,
          input.signal,
        ),
      );
    }
    const trackStart = runs[0]!.startMilliseconds;
    // The whole track as declared: from its first run's start to the latest declared end.
    const declared =
      runs.reduce((end, run) => Math.max(end, run.endMilliseconds), trackStart) - trackStart;
    const output = join(directory, `prepared.${format.extension}`);
    // Re-encoded on the timeline rather than copied, even for one run: a copy
    // keeps the capture's holes, and a model that decodes the file itself
    // would close them up and time its words early against our speaker turns
    // and the player. Each run is decoded, put on its timeline as it streams,
    // placed at its start time and mixed with the others, then encoded once.
    let writtenBytes = 0;
    const result = await runFfmpeg(
      input.ffmpegPath,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "info",
        "-stats",
        "-stats_period",
        "30",
        "-y",
        ...TIMELINE_PCM_ARGS,
        "-i",
        "pipe:0",
        "-c:a",
        format.codec,
        ...format.encoderArgs,
        "-f",
        format.muxer,
        output,
      ],
      input.signal,
      16_384,
      {
        stdin: async (stdin) => {
          const mixed = mixRuns(
            runs.map((run, index) => ({
              offset: timelineBytes(Math.max(0, run.startMilliseconds - trackStart)),
              pcm: () =>
                decodeRunOnTimeline(input.ffmpegPath, run.path, timelines[index]!, input.signal),
            })),
          );
          for await (const piece of mixed) {
            stdin.write(piece);
            await stdin.flush();
            writtenBytes += piece.byteLength;
          }
        },
      },
    );
    input.onProgress?.();
    const size = (await stat(output)).size;
    if (size === 0) throw new RecordingAudioError("The prepared audio is empty", "invalid_audio");
    const reported = ffmpegReportedMilliseconds(result.stderr);
    // Audio that came out materially longer than its chunks declared is not kept
    // (the second allows for frame rounding).
    if (reported !== null && reported > recordingDurationLimitMilliseconds(declared) + 1_000) {
      throw new RecordingAudioError("The audio runs past its declared length", "invalid_audio");
    }
    return {
      bytes: new Uint8Array(await readFile(output)),
      mimeType: format.mimeType,
      extension: format.extension,
      durationMilliseconds:
        reported ??
        Math.round((writtenBytes / TIMELINE_BYTES_PER_SAMPLE / TIMELINE_SAMPLE_RATE) * 1_000),
      offsetMilliseconds: trackStart,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Containers the worker can write for a model that needs a particular one. */
export type RecordingPieceFormat = "flac" | "wav" | "webm" | "mp4";

/**
 * Write an already prepared track file again in another format, such as a
 * kept meeting file made before meetings were kept as `ARCHIVAL_AUDIO_FORMAT`,
 * once its uploaded pieces are gone. The file already starts at its place
 * on the timeline, with its holes filled.
 */
export async function transcodeRecordingAudio(input: {
  audio: { bytes: Uint8Array; extension: string };
  format: PreparedAudioFormat;
  ffmpegPath: string;
  tempRoot?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<{
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  durationMilliseconds: number | null;
}> {
  const directory = await mkdtemp(
    join(input.tempRoot ?? tmpdir(), "opengeni-recording-transcode-"),
  );
  try {
    const source = join(directory, `source.${input.audio.extension}`);
    const output = join(directory, `transcoded.${input.format.extension}`);
    const handle = await open(source, "wx", 0o600);
    try {
      await handle.write(input.audio.bytes);
    } finally {
      await handle.close();
    }
    const { stderr } = await runFfmpeg(
      input.ffmpegPath,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "info",
        "-stats",
        "-stats_period",
        "30",
        "-y",
        "-i",
        source,
        "-vn",
        "-map",
        "0:a:0",
        "-af",
        RECORDING_TIMELINE_FILTER,
        "-c:a",
        input.format.codec,
        ...input.format.encoderArgs,
        "-f",
        input.format.muxer,
        output,
      ],
      input.signal,
    );
    const bytes = new Uint8Array(await readFile(output));
    if (bytes.byteLength === 0) {
      throw new RecordingAudioError("The transcoded audio is empty", "invalid_audio");
    }
    return {
      bytes,
      mimeType: input.format.mimeType,
      extension: input.format.extension,
      durationMilliseconds: ffmpegReportedMilliseconds(stderr),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const PIECE_OUTPUT: Record<
  RecordingPieceFormat,
  { extension: string; mimeType: string; args: string[] }
> = {
  // 16 kHz mono is what speech models run at; FLAC keeps it lossless.
  flac: {
    extension: "flac",
    mimeType: "audio/flac",
    args: [
      "-af",
      RECORDING_TIMELINE_FILTER,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "flac",
      "-f",
      "flac",
    ],
  },
  wav: {
    extension: "wav",
    mimeType: "audio/wav",
    args: [
      "-af",
      RECORDING_TIMELINE_FILTER,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
    ],
  },
  webm: { extension: "webm", mimeType: "audio/webm", args: ["-c:a", "copy", "-f", "webm"] },
  mp4: { extension: "m4a", mimeType: "audio/mp4", args: ["-c:a", "copy", "-f", "ipod"] },
};

/** Bytes per second of the converted formats, to size pieces under a file limit. */
export const RECORDING_PIECE_BYTES_PER_SECOND: Partial<Record<RecordingPieceFormat, number>> = {
  flac: 32_000,
  wav: 32_000,
};

/**
 * Quieter than this (-55 dBFS) is no speech: well below a voice, even a
 * soft one across the room, and above the near-silence of an idle
 * microphone or the digital silence of a computer playing nothing. The
 * aligner draws the same line.
 */
export const RECORDING_QUIET_DECIBELS = -55;
/** Only quiet this long is left out: short pauses go to the model with the speech around them. */
export const RECORDING_QUIET_MIN_MILLISECONDS = 20_000;
/** Sound kept on each side of a quiet stretch that is left out, so no word's edge is lost. */
export const RECORDING_QUIET_MARGIN_MILLISECONDS = 1_000;

/** The quiet stretches ffmpeg's `silencedetect` reported, a trailing one ending with the audio. */
export function parseSilences(
  stderr: string,
  durationMilliseconds: number,
): Array<{ startMilliseconds: number; endMilliseconds: number }> {
  const silences: Array<{ startMilliseconds: number; endMilliseconds: number }> = [];
  let start: number | null = null;
  for (const match of stderr.matchAll(/silence_(start|end): (-?\d+(?:\.\d+)?)/gu)) {
    const at = Math.max(0, Math.round(Number(match[2]) * 1_000));
    if (match[1] === "start") {
      start = at;
    } else if (start !== null) {
      silences.push({
        startMilliseconds: start,
        endMilliseconds: Math.min(at, durationMilliseconds),
      });
      start = null;
    }
  }
  if (start !== null && start < durationMilliseconds) {
    silences.push({ startMilliseconds: start, endMilliseconds: durationMilliseconds });
  }
  return silences;
}

/**
 * The stretches with sound between long quiet ones, each widened by a margin
 * into the quiet around it.
 */
export function soundBetweenSilences(
  silences: ReadonlyArray<{ startMilliseconds: number; endMilliseconds: number }>,
  durationMilliseconds: number,
  marginMilliseconds = RECORDING_QUIET_MARGIN_MILLISECONDS,
): Array<{ startMilliseconds: number; endMilliseconds: number }> {
  const sound: Array<{ startMilliseconds: number; endMilliseconds: number }> = [];
  const add = (startMilliseconds: number, endMilliseconds: number) => {
    const start = Math.max(0, startMilliseconds);
    const end = Math.min(durationMilliseconds, endMilliseconds);
    if (end <= start) return;
    const last = sound.at(-1);
    // Margins can reach over a short gap; join what touches.
    if (last && start <= last.endMilliseconds) {
      last.endMilliseconds = Math.max(last.endMilliseconds, end);
    } else {
      sound.push({ startMilliseconds: start, endMilliseconds: end });
    }
  };
  // Sound runs from the end of one silence to the start of the next.
  let soundFrom = 0;
  for (const silence of silences) {
    if (silence.startMilliseconds > soundFrom) {
      add(soundFrom - marginMilliseconds, silence.startMilliseconds + marginMilliseconds);
    }
    soundFrom = Math.max(soundFrom, silence.endMilliseconds);
  }
  if (soundFrom < durationMilliseconds) {
    add(soundFrom - marginMilliseconds, durationMilliseconds);
  }
  return sound;
}

/**
 * The stretches of a prepared track with sound in them, leaving out quiet
 * that lasts at least `RECORDING_QUIET_MIN_MILLISECONDS`. A track with no
 * sound at all has none, however short it is.
 */
export async function detectRecordingSound(input: {
  audio: { bytes: Uint8Array; extension: string };
  durationMilliseconds: number;
  ffmpegPath: string;
  tempRoot?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<Array<{ startMilliseconds: number; endMilliseconds: number }>> {
  // A track shorter than the minimum is quiet only when (nearly) all of it is.
  const minQuietSeconds = Math.max(
    0.1,
    Math.min(RECORDING_QUIET_MIN_MILLISECONDS, input.durationMilliseconds - 500) / 1_000,
  );
  const directory = await mkdtemp(join(input.tempRoot ?? tmpdir(), "opengeni-recording-sound-"));
  try {
    const source = join(directory, `source.${input.audio.extension}`);
    const handle = await open(source, "wx", 0o600);
    try {
      await handle.write(input.audio.bytes);
    } finally {
      await handle.close();
    }
    const { stderr } = await runFfmpeg(
      input.ffmpegPath,
      [
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "info",
        "-i",
        source,
        "-vn",
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-af",
        `silencedetect=noise=${RECORDING_QUIET_DECIBELS}dB:d=${minQuietSeconds}`,
        "-f",
        "null",
        "-",
      ],
      input.signal,
      1_048_576,
    );
    return soundBetweenSilences(
      parseSilences(stderr, input.durationMilliseconds),
      input.durationMilliseconds,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Cut one stretch of a prepared track into its own file in the given
 * format, for a model that can't take the track whole or as it is.
 */
export async function renderRecordingAudioPiece(input: {
  audio: { bytes: Uint8Array; extension: string };
  startMilliseconds: number;
  endMilliseconds: number;
  /** The whole track: no cut, only the conversion. */
  whole: boolean;
  format: RecordingPieceFormat;
  ffmpegPath: string;
  tempRoot?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<{ bytes: Uint8Array; mimeType: string; extension: string }> {
  const output = PIECE_OUTPUT[input.format];
  // A piece of speech PCM is cut from its samples: no decode, and the whole
  // track is never written out again for each of its pieces.
  const pcm = input.audio.extension === "wav" ? readPcmWav(input.audio.bytes) : null;
  if (pcm && pcm.sampleRate === 16_000) {
    const samples = pcm.data.byteLength / 2;
    const startSample = input.whole
      ? 0
      : Math.min(samples, Math.max(0, Math.round((input.startMilliseconds * 16_000) / 1_000)));
    const endSample = input.whole
      ? samples
      : Math.min(
          samples,
          Math.max(startSample, Math.round((input.endMilliseconds * 16_000) / 1_000)),
        );
    if (endSample <= startSample) {
      throw new RecordingAudioError("The audio piece is empty", "invalid_audio");
    }
    const piece = pcmWavPiece(pcm, startSample, endSample);
    if (input.format === "wav") {
      return { bytes: piece, mimeType: output.mimeType, extension: output.extension };
    }
    return await convertRecordingAudioPiece({
      ...input,
      audio: { bytes: piece, extension: "wav" },
      whole: true,
    });
  }
  return await convertRecordingAudioPiece(input);
}

async function convertRecordingAudioPiece(
  input: Parameters<typeof renderRecordingAudioPiece>[0],
): Promise<{ bytes: Uint8Array; mimeType: string; extension: string }> {
  const output = PIECE_OUTPUT[input.format];
  const directory = await mkdtemp(join(input.tempRoot ?? tmpdir(), "opengeni-recording-piece-"));
  try {
    const source = join(directory, `source.${input.audio.extension}`);
    const target = join(directory, `piece.${output.extension}`);
    const handle = await open(source, "wx", 0o600);
    try {
      await handle.write(input.audio.bytes);
    } finally {
      await handle.close();
    }
    // Seeking on the input jumps to the piece through the file's index;
    // seeking on the output decoded everything before it, so a long track's
    // later pieces each took as long as the track up to them.
    const seek = input.whole ? [] : ["-ss", (input.startMilliseconds / 1_000).toFixed(3)];
    const length = input.whole
      ? []
      : ["-t", (Math.max(0, input.endMilliseconds - input.startMilliseconds) / 1_000).toFixed(3)];
    await runFfmpeg(
      input.ffmpegPath,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        ...seek,
        "-i",
        source,
        ...length,
        "-vn",
        "-map",
        "0:a:0",
        ...output.args,
        target,
      ],
      input.signal,
    );
    const bytes = new Uint8Array(await readFile(target));
    if (bytes.byteLength === 0) {
      throw new RecordingAudioError("The audio piece is empty", "invalid_audio");
    }
    return { bytes, mimeType: output.mimeType, extension: output.extension };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
