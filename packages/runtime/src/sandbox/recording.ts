// @opengeni/runtime/sandbox — the recording loop (P4.3).
//
// ffmpeg x11grab on :0 → mp4/webm artifact on the box → read bytes → PUT to
// object storage → recording.available. The "agent films itself proving the fix"
// loop: ffmpeg reads exactly the :0 framebuffer the agent's computer-use draws to
// and the human watches over Channel B (zero projection).
//
// These are PLAIN functions over a live, externally-owned session handle — NO
// Temporal, NO worker RPC, NO actor. They live in the agent-loop-free leaf so the
// SAME process that already holds the resumed-by-id box (the agent turn's own
// activity for an on-turn recording, or the API in-process for an off-turn/manual
// finalize) reads the bytes and PUTs them straight to storage. The bytes go
// box → process memory → storage PUT and are NEVER serialized as a Temporal
// activity result — the 256 MB-vs-payload-limit concern dissolves (F10).
//
// ── Adversarial-review fixes folded in (module 05 §Adversarial) ──────────────
//   F1  exec is OPTIONAL on Modal (only execCommand) — every command dual-paths.
//   F3  exec/execCommand YIELDS — the SIGINT-and-wait loop is bounded well under
//       the yield window; the readFile (not exec) does the byte transfer.
//   F8  readFile maxBytes semantics are NOT assumed — we cap the ffmpeg file by
//       size on the box first (stat) and fail `max-bytes-exceeded` rather than
//       silently uploading a truncated video.
//   F9  the box file is deleted ONLY after the storage PUT confirms — never
//       before (so a failed upload leaves the bytes recoverable for a retry).
//   F12 ffmpeg/x11vnc backgrounding does not block the yield (nohup … & echo $!).
//   F14 duration is computed from wall-clock (stop − start), not assumed.

import { DESKTOP_STREAM_PORT } from "@opengeni/contracts";

export { DESKTOP_STREAM_PORT };

export type RecordingCodec = "h264-mp4" | "vp9-webm";
export type RecordingContentType = "video/mp4" | "video/webm";

const DEFAULT_MAX_SECONDS = 600; // 10 min hard ceiling (the -t bound)
const DEFAULT_FRAMERATE = 15;
const DEFAULT_MAX_BYTES = 268_435_456; // 256 MB
const DEFAULT_DIMENSIONS: [number, number] = [1280, 800];
// The SIGINT-and-wait loop is bounded well under the command yield window (F3).
const STOP_YIELD_MS = 20_000;
const EXEC_YIELD_MS = 15_000;

export function contentTypeForCodec(codec: RecordingCodec): RecordingContentType {
  return codec === "vp9-webm" ? "video/webm" : "video/mp4";
}
export function extForCodec(codec: RecordingCodec): string {
  return codec === "vp9-webm" ? "webm" : "mp4";
}

/** No exec/execCommand on the session — the box cannot run ffmpeg. */
export class RecordingUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "RecordingUnavailableError"; }
}
/** ffmpeg failed, the file is missing, or the byte read failed. */
export class RecordingError extends Error {
  constructor(message: string, readonly reason: "ffmpeg-error" | "box-death" | "max-bytes-exceeded" | "display-unavailable") {
    super(message);
    this.name = "RecordingError";
  }
}

// The structural slice of a provider session the recording loop drives. exec and
// execCommand are optional (Modal has only execCommand — F1); readFile present on
// every desktop-capable provider.
type ExecResultLike = { output?: string; stdout?: string; stderr?: string; exitCode?: number | null; sessionId?: number };
type RecordingSession = {
  exec?: (args: { cmd: string; runAs?: string; yieldTimeMs?: number; maxOutputTokens?: number }) => Promise<ExecResultLike>;
  execCommand?: (args: { cmd: string; runAs?: string; yieldTimeMs?: number; maxOutputTokens?: number }) => Promise<string>;
  readFile?: (args: { path: string; runAs?: string; maxBytes?: number }) => Promise<string | Uint8Array>;
};

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function resultOutput(result: ExecResultLike | string): string {
  if (typeof result === "string") return result;
  return [result.output, result.stderr, result.stdout].filter((v): v is string => typeof v === "string" && v.length > 0).join("\n");
}

async function run(session: RecordingSession, cmd: string, runAs?: string, yieldTimeMs = EXEC_YIELD_MS): Promise<string> {
  const args = { cmd, ...(runAs ? { runAs } : {}), yieldTimeMs, maxOutputTokens: 4_000 };
  if (typeof session.exec === "function") {
    return resultOutput(await session.exec(args));
  }
  if (typeof session.execCommand === "function") {
    return resultOutput(await session.execCommand(args));
  }
  throw new RecordingUnavailableError("session cannot run commands (no exec/execCommand) — recording unavailable");
}

export type StartRecordingInput = {
  recordingId: string;
  codec?: RecordingCodec;
  framerate?: number;
  maxSeconds?: number;
  dimensions?: [number, number];
  display?: string; // ":0"
  runAs?: string;
  tmpDir?: string; // "/tmp"
};

export type RecordingProcess = {
  recordingId: string;
  codec: RecordingCodec;
  boxPath: string;
  pidFile: string;
  dimensions: [number, number];
  framerate: number;
  /** epoch-ms when ffmpeg was launched (for duration computation, F14). */
  startedAt: number;
  display: string;
  runAs?: string;
};

/**
 * Launch ffmpeg x11grab on :0 → an mp4/webm file on the box. Backgrounded with
 * `nohup … & echo $!` so the launch returns immediately (F12 — the exec does not
 * block on the recording). A hard `-t <maxSeconds>` ceiling bounds a runaway file
 * across a multi-day turn. Returns the handle the caller carries to stop+finalize.
 */
export async function startRecording(session: unknown, input: StartRecordingInput): Promise<RecordingProcess> {
  const s = session as RecordingSession;
  const codec = input.codec ?? "h264-mp4";
  const dimensions = input.dimensions ?? DEFAULT_DIMENSIONS;
  const framerate = input.framerate ?? DEFAULT_FRAMERATE;
  const maxSeconds = input.maxSeconds ?? DEFAULT_MAX_SECONDS;
  const display = input.display ?? ":0";
  const tmp = input.tmpDir ?? "/tmp";
  const ext = extForCodec(codec);
  const boxPath = `${tmp}/og-rec-${input.recordingId}.${ext}`;
  const pidFile = `${tmp}/og-rec-${input.recordingId}.pid`;
  const logFile = `${tmp}/og-rec-${input.recordingId}.log`;
  const [w, h] = dimensions;
  const enc = codec === "vp9-webm"
    ? `-c:v libvpx-vp9 -b:v 0 -crf 32 -row-mt 1`
    : `-c:v libx264 -preset veryfast -pix_fmt yuv420p -movflags +faststart`;
  const ffmpeg =
    `nohup ffmpeg -hide_banner -loglevel error -f x11grab -draw_mouse 1 -framerate ${framerate} ` +
    `-video_size ${w}x${h} -i ${display}.0 -t ${maxSeconds} ${enc} ${boxPath} ` +
    `</dev/null >${logFile} 2>&1 & echo $! > ${pidFile}`;
  await run(s, `bash -lc ${shq(ffmpeg)}`, input.runAs);
  return {
    recordingId: input.recordingId,
    codec,
    boxPath,
    pidFile,
    dimensions,
    framerate,
    startedAt: Date.now(),
    display,
    ...(input.runAs ? { runAs: input.runAs } : {}),
  };
}

/**
 * SIGINT ffmpeg (so it writes a clean moov atom / webm trailer) and wait for the
 * pid to exit. Bounded well under the yield window (F3). Idempotent: a missing
 * pid file is a no-op.
 */
export async function stopRecording(session: unknown, proc: RecordingProcess): Promise<void> {
  const s = session as RecordingSession;
  const wait = `kill -INT "$(cat ${proc.pidFile})" 2>/dev/null; for i in $(seq 1 80); do kill -0 "$(cat ${proc.pidFile})" 2>/dev/null || break; sleep 0.1; done`;
  await run(s, `bash -lc ${shq(wait)}`, proc.runAs, STOP_YIELD_MS).catch(() => undefined);
}

export type FinalizeRecordingResult = {
  bytes: Uint8Array;
  contentType: RecordingContentType;
  sizeBytes: number;
  durationSeconds: number;
};

/**
 * Read the finalized recording bytes off the box.
 *
 * F8: we DO NOT assume readFile's over-limit behavior. First `stat` the file size
 * on the box; if it exceeds maxBytes, fail `max-bytes-exceeded` (never upload a
 * truncated video). Otherwise read the raw bytes via readFile.
 *
 * F9: this does NOT delete the box file. The caller deletes it (deleteRecordingArtifacts)
 * ONLY after the storage PUT + `available` commit — so a failed upload leaves the
 * bytes recoverable on the box for a retry.
 *
 * F14: duration is wall-clock (now − startedAt), a close approximation of the
 * SIGINT-flushed video length.
 */
export async function readRecordingBytes(session: unknown, proc: RecordingProcess, maxBytes = DEFAULT_MAX_BYTES): Promise<FinalizeRecordingResult> {
  const s = session as RecordingSession;
  if (typeof s.readFile !== "function") {
    throw new RecordingUnavailableError("session cannot read files (no readFile) — recording finalize unavailable");
  }
  // F8: size-gate on the box before reading into memory.
  const sizeOut = (await run(s, `bash -lc ${shq(`stat -c %s ${proc.boxPath} 2>/dev/null || echo MISSING`)}`, proc.runAs)).trim();
  const sizeLine = sizeOut.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "MISSING";
  if (sizeLine === "MISSING" || sizeLine === "") {
    throw new RecordingError(`recording file missing on box: ${proc.boxPath}`, "box-death");
  }
  const size = Number(sizeLine);
  if (!Number.isFinite(size) || size <= 0) {
    throw new RecordingError(`recording file empty on box: ${proc.boxPath}`, "ffmpeg-error");
  }
  if (size > maxBytes) {
    throw new RecordingError(`recording ${size}B exceeds max ${maxBytes}B`, "max-bytes-exceeded");
  }
  const data = await s.readFile!({ path: proc.boxPath, maxBytes, ...(proc.runAs ? { runAs: proc.runAs } : {}) });
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (bytes.length === 0) {
    throw new RecordingError(`recording read returned 0 bytes: ${proc.boxPath}`, "ffmpeg-error");
  }
  return {
    bytes,
    contentType: contentTypeForCodec(proc.codec),
    sizeBytes: bytes.length,
    durationSeconds: Math.max(0, Math.round((Date.now() - proc.startedAt) / 1000)),
  };
}

/**
 * Delete the box artifacts. F9: call this ONLY after the storage PUT confirmed
 * and the `available` row committed — never before. Best-effort; never throws.
 */
export async function deleteRecordingArtifacts(session: unknown, proc: RecordingProcess): Promise<void> {
  const s = session as RecordingSession;
  const logFile = proc.boxPath.replace(/\.(mp4|webm)$/, ".log");
  await run(s, `rm -f ${proc.boxPath} ${proc.pidFile} ${logFile}`, proc.runAs).catch(() => undefined);
}

/** The storage object key for a recording artifact (parallels the file-asset layout). */
export function recordingStorageKey(workspaceId: string, sessionId: string, recordingId: string, codec: RecordingCodec): string {
  return `recordings/${workspaceId}/${sessionId}/${recordingId}.${extForCodec(codec)}`;
}
