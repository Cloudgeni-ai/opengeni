// Records the audio other apps play (a meeting's other participants) for the
// web app's meeting recorder. A small native helper does the capture: a Core
// Audio process tap on macOS 14.2 and later (the "System Audio Recording"
// permission, no screen recording), process loopback on Windows 10 2004 and
// later, and the sound server's monitor on Linux. It leaves the app's own
// processes out, writes mono float samples to stdout and stops when its stdin
// closes. This module runs it and forwards the samples to the page that asked.

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { release } from "node:os";

import type {
  DesktopSystemAudioError,
  DesktopSystemAudioErrorCode,
} from "../contract";

/** How often samples go to the page: a tenth of a second. */
const BATCHES_PER_SECOND = 10;
const START_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 3_000;

export interface SystemAudioTarget {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export interface SystemAudioChannels {
  samples: string;
  ended: string;
}

export interface SystemAudioOptions {
  /** The helper executable, or null when the app doesn't bundle one. */
  helperPath: string | null;
  /** Extra arguments before the exclusions, for tests. */
  helperArgs?: readonly string[];
  /** Processes to leave out: the app itself and its helpers. */
  excludePid: number;
  /** macOS: leave out processes whose bundle id starts with this (the app's helpers). */
  excludeBundlePrefix: string;
  channels: SystemAudioChannels;
  platform?: NodeJS.Platform;
  /** The OS kernel release, for the platform version check. */
  osRelease?: string;
  spawnProcess?: typeof spawn;
}

/** Whether this OS version can record other apps' audio. */
export function systemAudioSupported(
  platform: NodeJS.Platform,
  osRelease: string,
): boolean {
  const [major = 0, minor = 0, patch = 0] = osRelease
    .split(".")
    .map((part) => Number(part) || 0);
  // Darwin 23.2 is macOS 14.2, the first with Core Audio process taps.
  if (platform === "darwin") return major > 23 || (major === 23 && minor >= 2);
  // Build 19041 is Windows 10 version 2004, the first with process loopback.
  if (platform === "win32")
    return major > 10 || (major === 10 && patch >= 19041);
  return platform === "linux";
}

/** Whether the app can offer recording other apps' audio with this helper here. */
export function systemAudioUsable(
  helperPath: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
  osRelease: string = release(),
): boolean {
  return Boolean(
    helperPath &&
    existsSync(helperPath) &&
    systemAudioSupported(platform, osRelease),
  );
}

const MESSAGES: Record<DesktopSystemAudioErrorCode, string> = {
  unavailable: "This computer can't record other apps' audio.",
  permission_denied:
    "Recording other apps' audio isn't allowed. Allow this app under System Settings > Privacy & Security > Screen & System Audio Recording, then try again.",
  sound_server_unavailable:
    "Other apps' audio can't be recorded because no sound server (PulseAudio or PipeWire) is running.",
  capture_failed: "Recording other apps' audio stopped unexpectedly.",
};

function captureError(
  code: string | undefined,
  detail?: string,
): DesktopSystemAudioError {
  const known: DesktopSystemAudioErrorCode =
    code === "permission_denied" ||
    code === "sound_server_unavailable" ||
    code === "unavailable"
      ? code
      : "capture_failed";
  return {
    code: known,
    message: MESSAGES[known],
    ...(detail ? { detail } : {}),
  };
}

interface Capture {
  id: string;
  target: SystemAudioTarget;
  child: ChildProcess;
  sampleRate: number;
  pending: Buffer[];
  pendingBytes: number;
  stopping: boolean;
  ended: boolean;
}

export class SystemAudioCaptures {
  private readonly captures = new Map<string, Capture>();

  constructor(private readonly options: SystemAudioOptions) {}

  /** Whether the app can offer recording other apps' audio here. */
  available(): boolean {
    return systemAudioUsable(
      this.options.helperPath,
      this.options.platform ?? process.platform,
      this.options.osRelease ?? release(),
    );
  }

  /**
   * Start a capture for one page. Resolves once audio flows, with the id the
   * page's samples carry. A page has at most one capture: starting again ends
   * the previous one.
   */
  start(
    target: SystemAudioTarget,
  ): Promise<{ captureId: string; sampleRate: number }> {
    if (!this.available() || !this.options.helperPath) {
      return Promise.reject(captureError("unavailable"));
    }
    for (const capture of this.captures.values()) {
      if (capture.target.id === target.id) this.stop(capture.id);
    }
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(
      this.options.helperPath,
      [
        ...(this.options.helperArgs ?? []),
        "--exclude-pid",
        String(this.options.excludePid),
        "--exclude-bundle-prefix",
        this.options.excludeBundlePrefix,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const capture: Capture = {
      id: randomUUID(),
      target,
      child,
      sampleRate: 0,
      pending: [],
      pendingBytes: 0,
      stopping: false,
      ended: false,
    };
    this.captures.set(capture.id, capture);
    return new Promise((resolve, reject) => {
      let settled = false;
      let lastError: DesktopSystemAudioError | null = null;
      const settle = (error: DesktopSystemAudioError | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.stop(capture.id);
          reject(error);
        } else {
          resolve({ captureId: capture.id, sampleRate: capture.sampleRate });
        }
      };
      const timer = setTimeout(
        () =>
          settle(
            captureError("capture_failed", "The helper did not start in time."),
          ),
        START_TIMEOUT_MS,
      );
      let lines = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (text: string) => {
        lines += text;
        let newline = lines.indexOf("\n");
        while (newline >= 0) {
          const line = lines.slice(0, newline).trim();
          lines = lines.slice(newline + 1);
          newline = lines.indexOf("\n");
          if (!line) continue;
          let event: {
            event?: string;
            sampleRate?: number;
            code?: string;
            message?: string;
          };
          try {
            event = JSON.parse(line) as typeof event;
          } catch {
            continue;
          }
          if (
            event.event === "started" &&
            typeof event.sampleRate === "number"
          ) {
            capture.sampleRate = event.sampleRate;
            if (capture.pendingBytes > 0) this.flush(capture);
            settle(null);
          } else if (event.event === "error") {
            lastError = captureError(event.code, event.message);
            settle(lastError);
          }
        }
      });
      child.stdout?.on("data", (chunk: Buffer) => this.receive(capture, chunk));
      child.on("error", (error) => {
        lastError = captureError("unavailable", error.message);
        settle(lastError);
        this.finish(capture, lastError);
      });
      child.on("exit", (code) => {
        const error =
          capture.stopping && code === 0
            ? null
            : (lastError ??
              captureError(
                "capture_failed",
                `The helper exited with ${code}.`,
              ));
        settle(
          error ??
            captureError(
              "capture_failed",
              "The helper exited before starting.",
            ),
        );
        this.finish(capture, error);
      });
    });
  }

  /** End one capture. Samples already sent stay valid. */
  stop(captureId: string, target?: SystemAudioTarget): void {
    const capture = this.captures.get(captureId);
    if (
      !capture ||
      (target && capture.target.id !== target.id) ||
      capture.stopping
    )
      return;
    capture.stopping = true;
    capture.child.stdin?.end();
    const timer = setTimeout(() => {
      if (capture.child.exitCode === null && capture.child.signalCode === null)
        capture.child.kill();
    }, STOP_GRACE_MS);
    timer.unref?.();
  }

  /** End every capture of a page (it navigated away or closed). */
  stopFor(target: SystemAudioTarget): void {
    for (const capture of this.captures.values()) {
      if (capture.target.id === target.id) this.stop(capture.id);
    }
  }

  stopAll(): void {
    for (const capture of this.captures.values()) this.stop(capture.id);
  }

  private receive(capture: Capture, chunk: Buffer): void {
    // Samples can arrive before the start line (two pipes); keep them until then.
    capture.pending.push(chunk);
    capture.pendingBytes += chunk.length;
    if (capture.sampleRate === 0) return;
    const batchBytes = Math.max(
      4,
      Math.floor(capture.sampleRate / BATCHES_PER_SECOND) * 4,
    );
    if (capture.pendingBytes >= batchBytes) this.flush(capture);
  }

  private flush(capture: Capture): void {
    const whole = capture.pendingBytes - (capture.pendingBytes % 4);
    if (whole === 0) return;
    const joined = Buffer.concat(capture.pending, capture.pendingBytes);
    // A fresh, aligned buffer: the page gets its own copy either way.
    const samples = new Float32Array(whole / 4);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = joined.readFloatLE(index * 4);
    }
    const rest = joined.subarray(whole);
    capture.pending = rest.length > 0 ? [Buffer.from(rest)] : [];
    capture.pendingBytes = rest.length;
    if (!capture.target.isDestroyed()) {
      capture.target.send(this.options.channels.samples, capture.id, samples);
    }
  }

  private finish(
    capture: Capture,
    error: DesktopSystemAudioError | null,
  ): void {
    if (capture.ended) return;
    capture.ended = true;
    this.flush(capture);
    this.captures.delete(capture.id);
    if (!capture.target.isDestroyed()) {
      capture.target.send(this.options.channels.ended, capture.id, error);
    }
  }
}
