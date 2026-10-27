/**
 * Browser recording: a change-driven video of what an agent did in a browser.
 *
 * Chromium's screencast sends a JPEG only when the page repaints, so a still
 * page costs nothing. Each distinct frame is spooled to disk with its capture
 * time; memory stays flat however long the recording runs. Stopping writes one
 * bundle file (a JSON header followed by the frame bytes) that the controller
 * exports through a scoped upload grant. The server encodes the video, so
 * browser hosts need no video encoder.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { InteractionControllerError } from "@opengeni/interaction";
import { errorMessage } from "@opengeni/contracts/values";

export const RECORDING_BUNDLE_MAGIC = "OGREC1\n";
export const RECORDING_MAX_DURATION_MS = 30 * 60_000;
export const RECORDING_MAX_FRAME_BYTES = 200 * 1024 * 1024;
export const RECORDING_MAX_ACTIONS = 10_000;

/** Stops one target's frame stream. */
export type RecordingFrameStop = () => Promise<void>;

/** The part of a browser driver a recording reads frames from. */
export type RecordingFrameSource = (
  targetId: string,
  onFrame: (jpeg: Uint8Array, capturedAtMs: number) => void,
  onEnd: (error: Error | null) => void,
) => Promise<RecordingFrameStop>;

export type RecordingState = "recording" | "stopped";
export type RecordingStopReason = "requested" | "duration_limit" | "size_limit" | "session_ended";

export type RecordingFrameEntry = {
  /** Milliseconds since the recording started. */
  t: number;
  offset: number;
  length: number;
  targetId: string;
};

export type RecordingActionEntry = {
  /** Milliseconds since the recording started. */
  t: number;
  kind: "action" | "open_tab" | "select_tab";
  targetId: string;
  url?: string;
  /** The action as the agent sent it. Secret references stay references. */
  action?: unknown;
};

export type RecordingSummary = {
  recordingId: string;
  state: RecordingState;
  startedAt: string;
  stoppedAt: string | null;
  stopReason: RecordingStopReason | null;
  durationMs: number;
  frameCount: number;
  frameBytes: number;
  actionCount: number;
  /** Present once stopped: the exportable bundle. */
  bundle: { sizeBytes: number; sha256: string } | null;
  /** Why frames stopped arriving early, when they did. */
  streamError: string | null;
};

type Clock = () => number;

/** One upload of a stopped recording's bundle to one storage object. */
type RecordingTransfer = {
  /** The object, without its signature: a renewed grant names the same one. */
  target: string;
  state: "uploading" | "uploaded" | "failed";
  done: Promise<void>;
};

export class BrowserRecording {
  readonly recordingId = randomUUID();
  private readonly startedAtMs: number;
  private readonly directory: string;
  private readonly framesPath: string;
  private readonly frames: RecordingFrameEntry[] = [];
  private readonly actions: RecordingActionEntry[] = [];
  private frameBytes = 0;
  private lastHash = "";
  private state: RecordingState = "recording";
  private stoppedAtMs: number | null = null;
  private stopReason: RecordingStopReason | null = null;
  private streamError: string | null = null;
  private targetId: string;
  private source: RecordingFrameSource;
  private stopStream: RecordingFrameStop | null = null;
  private switching: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private writeHandle: Awaited<ReturnType<typeof open>> | null = null;
  private bundle: { path: string; sizeBytes: number; sha256: string } | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private releasePresence: () => void;
  private transfer: RecordingTransfer | null = null;

  private constructor(
    parentDirectory: string,
    targetId: string,
    source: RecordingFrameSource,
    releasePresence: () => void,
    private readonly now: Clock,
  ) {
    this.startedAtMs = now();
    this.directory = join(parentDirectory, this.recordingId);
    this.framesPath = join(this.directory, "frames.bin");
    this.targetId = targetId;
    this.source = source;
    this.releasePresence = releasePresence;
  }

  /** Starts recording one target. The caller keeps the browser presented
   * until `releasePresence` runs, because a parked window stops painting. */
  static async start(input: {
    directory: string;
    targetId: string;
    source: RecordingFrameSource;
    releasePresence: () => void;
    now?: Clock;
  }): Promise<BrowserRecording> {
    const recording = new BrowserRecording(
      input.directory,
      input.targetId,
      input.source,
      input.releasePresence,
      input.now ?? Date.now,
    );
    try {
      await mkdir(recording.directory, { recursive: true, mode: 0o700 });
      recording.writeHandle = await open(recording.framesPath, "w", 0o600);
      recording.stopStream = await recording.attach(input.targetId);
    } catch (error) {
      recording.releasePresence();
      await recording.writeHandle?.close().catch(() => undefined);
      await rm(recording.directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    recording.limitTimer = setTimeout(() => {
      void recording.stop("duration_limit").catch(() => undefined);
    }, RECORDING_MAX_DURATION_MS);
    recording.limitTimer.unref?.();
    return recording;
  }

  get isRecording(): boolean {
    return this.state === "recording";
  }

  /** The agent used a tab: log it and follow it if it is another tab. */
  noteTarget(
    kind: RecordingActionEntry["kind"],
    targetId: string,
    detail: { url?: string; action?: unknown } = {},
  ): void {
    if (this.state !== "recording") return;
    if (this.actions.length < RECORDING_MAX_ACTIONS) {
      this.actions.push({ t: this.elapsed(), kind, targetId, ...detail });
    }
    if (targetId !== this.targetId) this.follow(targetId);
  }

  /** The browser was replaced (recovery): stream from its new driver. */
  rebind(source: RecordingFrameSource): void {
    if (this.state !== "recording" || source === this.source) return;
    this.source = source;
    this.follow(this.targetId, true);
  }

  summary(): RecordingSummary {
    const end = this.stoppedAtMs ?? this.now();
    return {
      recordingId: this.recordingId,
      state: this.state,
      startedAt: new Date(this.startedAtMs).toISOString(),
      stoppedAt: this.stoppedAtMs === null ? null : new Date(this.stoppedAtMs).toISOString(),
      stopReason: this.stopReason,
      durationMs: Math.max(0, end - this.startedAtMs),
      frameCount: this.frames.length,
      frameBytes: this.frameBytes,
      actionCount: this.actions.length,
      bundle: this.bundle ? { sizeBytes: this.bundle.sizeBytes, sha256: this.bundle.sha256 } : null,
      streamError: this.streamError,
    };
  }

  /** Stops capturing and writes the exportable bundle. Idempotent. */
  async stop(reason: RecordingStopReason = "requested"): Promise<RecordingSummary> {
    if (this.state === "recording") {
      this.state = "stopped";
      this.stoppedAtMs = this.now();
      this.stopReason = reason;
      if (this.limitTimer) clearTimeout(this.limitTimer);
      this.releasePresence();
      await this.switching.catch(() => undefined);
      await this.stopStream?.().catch(() => undefined);
      this.stopStream = null;
      await this.writes.catch(() => undefined);
      await this.writeHandle?.close().catch(() => undefined);
      this.writeHandle = null;
      this.bundleWrite ??= this.writeBundle();
    }
    await this.bundleWrite;
    return this.summary();
  }

  private bundleWrite: Promise<void> | null = null;

  /** Path and integrity of the stopped recording's bundle. */
  exportable(): { path: string; sizeBytes: number; sha256: string } {
    if (!this.bundle) {
      throw new InteractionControllerError(
        "operation_conflict",
        "stop the recording before exporting it",
      );
    }
    return this.bundle;
  }

  async discard(): Promise<void> {
    await this.stop("session_ended").catch(() => undefined);
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Uploads the stopped bundle to `target`, or joins the upload already going
   * there, so a caller that gave up waiting and asks again never starts a
   * second copy. A finished upload to the same object is not repeated
   * unless `replace` asks for it. A failed one is replaced by the next
   * request, and an upload to another object starts once the current one
   * settles.
   */
  transferTo(target: string, upload: () => Promise<void>, replace = false): RecordingTransfer {
    this.exportable();
    const current = this.transfer;
    if (
      current &&
      current.target === target &&
      (current.state === "uploading" || (current.state === "uploaded" && !replace))
    ) {
      return current;
    }
    const previous =
      current?.state === "uploading" ? current.done.catch(() => undefined) : Promise.resolve();
    const transfer: RecordingTransfer = { target, state: "uploading", done: Promise.resolve() };
    transfer.done = previous.then(upload).then(
      () => {
        transfer.state = "uploaded";
      },
      (error: unknown) => {
        transfer.state = "failed";
        throw error;
      },
    );
    // Callers may stop waiting; the outcome stays readable on the transfer.
    transfer.done.catch(() => undefined);
    this.transfer = transfer;
    return transfer;
  }

  private elapsed(): number {
    return Math.max(0, this.now() - this.startedAtMs);
  }

  private follow(targetId: string, force = false): void {
    const previous = this.targetId;
    this.targetId = targetId;
    this.switching = this.switching
      .then(async () => {
        if (this.state !== "recording") return;
        if (!force && previous === targetId) return;
        const stopPrevious = this.stopStream;
        this.stopStream = null;
        await stopPrevious?.().catch(() => undefined);
        if (this.state !== "recording") return;
        this.stopStream = await this.attach(targetId);
      })
      .catch((error: unknown) => {
        this.streamError = errorMessage(error);
      });
  }

  private async attach(targetId: string): Promise<RecordingFrameStop> {
    return await this.source(
      targetId,
      (jpeg) => this.accept(jpeg, targetId),
      (error) => {
        if (error && this.state === "recording" && this.targetId === targetId) {
          this.streamError = error.message;
        }
      },
    );
  }

  private accept(jpeg: Uint8Array, targetId: string): void {
    if (this.state !== "recording" || targetId !== this.targetId) return;
    // Chromium repeats a frame when only invisible state changed.
    const hash = createHash("sha1").update(jpeg).digest("hex");
    if (hash === this.lastHash) return;
    this.lastHash = hash;
    if (this.frameBytes + jpeg.byteLength > RECORDING_MAX_FRAME_BYTES) {
      void this.stop("size_limit").catch(() => undefined);
      return;
    }
    const entry: RecordingFrameEntry = {
      t: this.elapsed(),
      offset: this.frameBytes,
      length: jpeg.byteLength,
      targetId,
    };
    this.frames.push(entry);
    this.frameBytes += jpeg.byteLength;
    const handle = this.writeHandle;
    this.writes = this.writes.then(async () => {
      await handle?.write(jpeg, 0, jpeg.byteLength, entry.offset);
    });
  }

  private async writeBundle(): Promise<void> {
    const header = Buffer.from(
      `${JSON.stringify({
        version: 1,
        recordingId: this.recordingId,
        startedAt: new Date(this.startedAtMs).toISOString(),
        durationMs: (this.stoppedAtMs ?? this.now()) - this.startedAtMs,
        mediaType: "image/jpeg",
        frames: this.frames,
        actions: this.actions,
      })}\n`,
    );
    const path = join(this.directory, "recording.bundle");
    const handle = await open(path, "w", 0o600);
    const hash = createHash("sha256");
    try {
      const prefix = Buffer.concat([Buffer.from(RECORDING_BUNDLE_MAGIC), header]);
      await handle.write(prefix);
      hash.update(prefix);
      if (this.frameBytes > 0) {
        for await (const chunk of createReadStream(this.framesPath)) {
          await handle.write(chunk as Buffer);
          hash.update(chunk as Buffer);
        }
      }
    } finally {
      await handle.close();
    }
    await rm(this.framesPath, { force: true });
    const facts = await stat(path);
    this.bundle = { path, sizeBytes: facts.size, sha256: hash.digest("hex") };
  }
}
