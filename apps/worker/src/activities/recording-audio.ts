import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Turning a track's uploaded chunks into one seekable audio file.
 *
 * A browser MediaRecorder writes one container header and then appends
 * clusters, so the chunks of one capture session concatenate into a valid
 * file. A reload, a crash or a device switch starts a new session with a new
 * header. Each session becomes one "run"; runs are placed on the recording's
 * timeline by their first chunk's start time.
 */

export type RecordingAudioChunk = {
  chunkNumber: number;
  startMilliseconds: number;
  durationMilliseconds: number;
  objectKey: string;
};

export type RecordingAudioRun = {
  startMilliseconds: number;
  chunks: RecordingAudioChunk[];
};

export type RecordingAudioContainer = "webm" | "mp4" | "ogg";

export function recordingAudioContainer(mimeType: string): RecordingAudioContainer | null {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  if (base === "audio/webm" || base === "video/webm") return "webm";
  if (base === "audio/mp4" || base === "video/mp4" || base === "audio/x-m4a") return "mp4";
  if (base === "audio/ogg" || base === "application/ogg") return "ogg";
  return null;
}

/** Whether a chunk begins a new container: an EBML, MP4 `ftyp` or Ogg header. */
export function startsContainer(bytes: Uint8Array): boolean {
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
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

/** The prepared file's container, extension and MIME type for a source container. */
export function preparedAudioFormat(container: RecordingAudioContainer): {
  extension: string;
  mimeType: string;
  muxer: string;
  codec: string;
} {
  // MP4 sources (Safari) are AAC; everything else is Opus. Keep the codec so
  // a single run is only remuxed, never re-encoded.
  return container === "mp4"
    ? { extension: "m4a", mimeType: "audio/mp4", muxer: "ipod", codec: "aac" }
    : { extension: "webm", mimeType: "audio/webm", muxer: "webm", codec: "libopus" };
}

export class RecordingAudioError extends Error {
  readonly name = "RecordingAudioError";
  constructor(
    message: string,
    readonly code: "invalid_audio" | "missing_chunk" | "ffmpeg_failed",
  ) {
    super(message);
  }
}

const FFMPEG_TIMEOUT_MS = 30 * 60 * 1_000;

function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      stderr = (stderr + data).slice(-16_384);
    });
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, FFMPEG_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (code === 0) resolve({ stderr });
      else
        reject(
          new RecordingAudioError(
            `ffmpeg could not prepare the audio: ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400) || `exit ${code}`}`,
            "ffmpeg_failed",
          ),
        );
    });
  });
}

/** The last `time=` ffmpeg reports, which is the written file's length. */
export function ffmpegReportedMilliseconds(stderr: string): number | null {
  const matches = [...stderr.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/gu)];
  const last = matches.at(-1);
  if (!last) return null;
  return Math.round(
    (Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1_000,
  );
}

export type PreparedRecordingAudio = {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  durationMilliseconds: number;
  /** Where the file starts on the recording timeline. */
  offsetMilliseconds: number;
};

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
  tempRoot?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: (() => void) | undefined;
}): Promise<PreparedRecordingAudio> {
  const container = recordingAudioContainer(input.mimeType);
  if (!container) {
    throw new RecordingAudioError(`Unsupported audio type ${input.mimeType}`, "invalid_audio");
  }
  const format = preparedAudioFormat(container);
  const ordered = [...input.chunks].sort((left, right) => left.chunkNumber - right.chunkNumber);
  if (ordered.length === 0) throw new RecordingAudioError("The track has no audio", "invalid_audio");
  const directory = await mkdtemp(join(input.tempRoot ?? tmpdir(), "opengeni-recording-"));
  try {
    const runs: Array<{ startMilliseconds: number; path: string }> = [];
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      for (const chunk of ordered) {
        input.signal?.throwIfAborted();
        const bytes = await input.readChunk(chunk);
        if (!bytes) {
          throw new RecordingAudioError(`Chunk ${chunk.chunkNumber} is missing`, "missing_chunk");
        }
        if (!handle || startsContainer(bytes)) {
          if (!handle && !startsContainer(bytes)) {
            throw new RecordingAudioError(
              "The first chunk of the track has no container header",
              "invalid_audio",
            );
          }
          await handle?.close();
          const path = join(directory, `run-${runs.length}.${container}`);
          handle = await open(path, "wx", 0o600);
          runs.push({ startMilliseconds: chunk.startMilliseconds, path });
        }
        await handle.write(bytes);
        input.onProgress?.();
      }
    } finally {
      await handle?.close();
    }
    const output = join(directory, `prepared.${format.extension}`);
    const base = ["-nostdin", "-hide_banner", "-loglevel", "info", "-stats", "-stats_period", "30", "-y"];
    let result: { stderr: string };
    if (runs.length === 1) {
      result = await runFfmpeg(
        input.ffmpegPath,
        [...base, "-i", runs[0]!.path, "-vn", "-map", "0:a:0", "-c:a", "copy", "-f", format.muxer, output],
        input.signal,
      );
    } else {
      const inputs = runs.flatMap((run) => ["-i", run.path]);
      const first = runs[0]!.startMilliseconds;
      const delayed = runs
        .map((run, index) => {
          const delay = Math.max(0, run.startMilliseconds - first);
          return `[${index}:a:0]aresample=48000,aformat=channel_layouts=mono,adelay=${delay}:all=1[a${index}]`;
        })
        .join(";");
      const mix = `${runs.map((_, index) => `[a${index}]`).join("")}amix=inputs=${runs.length}:normalize=0:dropout_transition=0[out]`;
      result = await runFfmpeg(
        input.ffmpegPath,
        [
          ...base,
          ...inputs,
          "-filter_complex",
          `${delayed};${mix}`,
          "-map",
          "[out]",
          "-c:a",
          format.codec,
          "-b:a",
          container === "mp4" ? "64k" : "32k",
          "-ac",
          "1",
          "-f",
          format.muxer,
          output,
        ],
        input.signal,
      );
    }
    input.onProgress?.();
    const size = (await stat(output)).size;
    if (size === 0) throw new RecordingAudioError("The prepared audio is empty", "invalid_audio");
    const reported = ffmpegReportedMilliseconds(result.stderr);
    const lastChunk = ordered.at(-1)!;
    const declared = lastChunk.startMilliseconds + lastChunk.durationMilliseconds - runs[0]!.startMilliseconds;
    return {
      bytes: new Uint8Array(await readFile(output)),
      mimeType: format.mimeType,
      extension: format.extension,
      durationMilliseconds: reported ?? Math.max(0, declared),
      offsetMilliseconds: runs[0]!.startMilliseconds,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
