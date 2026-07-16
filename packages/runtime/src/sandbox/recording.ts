// @opengeni/runtime/sandbox — the recording loop (P4.3).
//
// ffmpeg x11grab on :0 → mp4/webm artifact on the box → direct scoped PUT to
// object storage → recording.available. The "agent films itself proving the fix"
// loop: ffmpeg reads exactly the :0 framebuffer the agent's computer-use draws to
// and the human watches over Channel B (zero projection).
//
// These are PLAIN functions over a live, externally-owned session handle — NO
// Temporal, NO worker RPC, NO actor. They live in the agent-loop-free leaf so the
// SAME process that already holds the resumed-by-id box (the agent turn's own
// activity for an on-turn recording, or the API in-process for an off-turn/manual
// finalize) authorizes a direct box-to-storage upload. Recording bytes never
// enter worker memory or a Temporal payload (F10).
//
// ── Adversarial-review fixes folded in (module 05 §Adversarial) ──────────────
//   F1  exec is OPTIONAL on Modal (only execCommand) — every command dual-paths.
//   F3  exec/execCommand YIELDS — the stop and direct-upload commands are bounded.
//   F8  size is gated on the box first (stat); over-limit artifacts fail instead
//       of being uploaded partially.
//   FR  curl reads the absolute /tmp artifact in the box and sends it directly to
//       the short-lived scoped URL. No workspace-root read API is involved.
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
  constructor(message: string) {
    super(message);
    this.name = "RecordingUnavailableError";
  }
}
/** ffmpeg failed, the file is missing, or the artifact is over its size limit. */
export class RecordingError extends Error {
  constructor(
    message: string,
    readonly reason: "ffmpeg-error" | "box-death" | "max-bytes-exceeded" | "display-unavailable",
  ) {
    super(message);
    this.name = "RecordingError";
  }
}

// The structural slice of a provider session the recording loop drives. exec and
// execCommand are optional (Modal has only execCommand — F1).
type ExecResultLike = {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  sessionId?: number;
};
type RecordingSession = {
  exec?: (args: {
    cmd: string;
    runAs?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<ExecResultLike>;
  execCommand?: (args: {
    cmd: string;
    runAs?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<string>;
};

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function resultOutput(result: ExecResultLike | string): string {
  if (typeof result === "string") return result;
  return [result.output, result.stderr, result.stdout]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join("\n");
}

// Default per-command output cap (tokens). Recording transfer does not use stdout.
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;

async function run(
  session: RecordingSession,
  cmd: string,
  runAs?: string,
  yieldTimeMs = EXEC_YIELD_MS,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
): Promise<string> {
  const args: {
    cmd: string;
    runAs?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  } = { cmd, ...(runAs ? { runAs } : {}), yieldTimeMs, maxOutputTokens };
  if (typeof session.exec === "function") {
    return resultOutput(await session.exec(args));
  }
  if (typeof session.execCommand === "function") {
    return resultOutput(await session.execCommand(args));
  }
  throw new RecordingUnavailableError(
    "session cannot run commands (no exec/execCommand) — recording unavailable",
  );
}

// Extract the command body from a provider exec banner. Modal's execCommand
// returns "<chunk banner>\nProcess exited…\nOutput:\n<body>"; the body is what
// follows the last "Output:\n" marker. Plain exec results (no banner) pass
// through unchanged.
function stripExecBanner(raw: string): string {
  const marker = raw.lastIndexOf("\nOutput:\n");
  if (marker >= 0) return raw.slice(marker + "\nOutput:\n".length);
  if (raw.startsWith("Output:\n")) return raw.slice("Output:\n".length);
  return raw;
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
export async function startRecording(
  session: unknown,
  input: StartRecordingInput,
): Promise<RecordingProcess> {
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
  const enc =
    codec === "vp9-webm"
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

export type RecordingArtifactMetadata = {
  contentType: RecordingContentType;
  sizeBytes: number;
  durationSeconds: number;
};

/**
 * Inspect and size-gate the finalized recording while it is still on the box.
 * No recording bytes cross into the worker process.
 */
export async function inspectRecordingArtifact(
  session: unknown,
  proc: RecordingProcess,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<RecordingArtifactMetadata> {
  const s = session as RecordingSession;
  if (typeof s.exec !== "function" && typeof s.execCommand !== "function") {
    throw new RecordingUnavailableError(
      "session cannot run commands (no exec/execCommand) — recording finalize unavailable",
    );
  }
  // F8: size-gate on the box before authorizing the upload.
  const sizeOut = (
    await run(
      s,
      `bash -lc ${shq(`stat -c %s ${proc.boxPath} 2>/dev/null || echo MISSING`)}`,
      proc.runAs,
    )
  ).trim();
  const sizeLine =
    sizeOut
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "MISSING";
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
  return {
    contentType: contentTypeForCodec(proc.codec),
    sizeBytes: size,
    durationSeconds: Math.max(0, Math.round((Date.now() - proc.startedAt) / 1000)),
  };
}

const RECORDING_UPLOAD_OK = "OPENGENI_RECORDING_UPLOAD_OK";
const RECORDING_UPLOAD_MAX_SECONDS = 300;

/**
 * Upload the finalized artifact directly from the sandbox to a scoped object-
 * storage URL. The worker carries only the short URL/headers and metadata; it
 * never materializes a base64 string or Uint8Array for a recording that may be
 * hundreds of megabytes. curl's success marker makes an exec transport that
 * returns non-zero command output instead of throwing still fail closed.
 */
export async function uploadRecordingArtifact(
  session: unknown,
  proc: RecordingProcess,
  input: {
    url: string;
    requiredHeaders: Record<string, string>;
    maxBytes?: number;
    maxSeconds?: number;
  },
): Promise<RecordingArtifactMetadata> {
  const maxSeconds = input.maxSeconds ?? RECORDING_UPLOAD_MAX_SECONDS;
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds <= 0 || maxSeconds > 300) {
    throw new Error("recording upload maxSeconds must be an integer between 1 and 300");
  }
  const metadata = await inspectRecordingArtifact(session, proc, input.maxBytes);
  const headers = Object.entries(input.requiredHeaders)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `--header ${shq(`${name}: ${value}`)}`)
    .join(" ");
  const upload = [
    "set -euo pipefail",
    `curl --fail --silent --show-error --connect-timeout 20 --max-time ${maxSeconds} --request PUT ${headers} --upload-file ${shq(proc.boxPath)} ${shq(input.url)}`,
    `printf '${RECORDING_UPLOAD_OK}\\n'`,
  ].join("; ");
  const output = stripExecBanner(
    await run(
      session as RecordingSession,
      `bash -lc ${shq(upload)}`,
      proc.runAs,
      (maxSeconds + 10) * 1_000,
    ),
  );
  if (!output.includes(RECORDING_UPLOAD_OK)) {
    throw new Error("recording upload did not confirm success");
  }
  return metadata;
}

/**
 * Delete the box artifacts. F9: call this ONLY after the storage PUT confirmed
 * and the `available` row committed — never before. Best-effort; never throws.
 */
export async function deleteRecordingArtifacts(
  session: unknown,
  proc: RecordingProcess,
): Promise<void> {
  const s = session as RecordingSession;
  const logFile = proc.boxPath.replace(/\.(mp4|webm)$/, ".log");
  await run(s, `rm -f ${proc.boxPath} ${proc.pidFile} ${logFile}`, proc.runAs).catch(
    () => undefined,
  );
}

/** The storage object key for a recording artifact (parallels the file-asset layout). */
export function recordingStorageKey(
  workspaceId: string,
  sessionId: string,
  recordingId: string,
  codec: RecordingCodec,
): string {
  return `recordings/${workspaceId}/${sessionId}/${recordingId}.${extForCodec(codec)}`;
}
