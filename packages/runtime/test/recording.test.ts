import { describe, expect, test } from "bun:test";
import {
  startRecording,
  stopRecording,
  readRecordingBytes,
  deleteRecordingArtifacts,
  recordingStorageKey,
  contentTypeForCodec,
  extForCodec,
  RecordingError,
  RecordingUnavailableError,
  type RecordingProcess,
} from "../src/sandbox/recording";

// A mock session recording every command, mimicking the Modal execCommand
// (formatted-string-with-banner) contract. The recording loop reads bytes via a
// DIRECT `base64 <path>` exec (NOT readFile), so the mock answers stat + base64
// over the same exec channel.
function makeMockSession(opts: { fileBytes?: Uint8Array | null; statSize?: number | "MISSING" } = {}) {
  const execCalls: string[] = [];
  const base64Calls: string[] = [];
  const fmt = (body: string) => `Chunk ID: a\nProcess exited with code 0\nOutput:\n${body}`;
  const bytesFor = () => (opts.fileBytes === null ? new Uint8Array() : (opts.fileBytes ?? new Uint8Array([1, 2, 3, 4, 5])));
  const session: Record<string, unknown> = {
    execCommand: async (args: { cmd: string }) => {
      execCalls.push(args.cmd);
      if (args.cmd.includes("stat -c %s")) {
        const size = opts.statSize === undefined ? (opts.fileBytes?.length ?? 0) : opts.statSize;
        return fmt(String(size));
      }
      if (args.cmd.includes("base64 ")) {
        base64Calls.push(args.cmd);
        // base64 typically wraps at 76 cols + a trailing newline; the reader
        // strips all whitespace, so emit a realistic wrapped body.
        const b64 = Buffer.from(bytesFor()).toString("base64").replace(/(.{4})/g, "$1\n");
        return fmt(b64 + "\n");
      }
      return fmt("");
    },
  };
  return { session, execCalls, base64Calls };
}

describe("recording loop (P4.3)", () => {
  test("startRecording launches a backgrounded ffmpeg x11grab on :0 with a -t ceiling", async () => {
    const { session, execCalls } = makeMockSession();
    const proc = await startRecording(session, {
      recordingId: "rec-1",
      codec: "h264-mp4",
      framerate: 15,
      maxSeconds: 600,
      dimensions: [1280, 800],
    });
    expect(proc.boxPath).toBe("/tmp/og-rec-rec-1.mp4");
    expect(proc.pidFile).toBe("/tmp/og-rec-rec-1.pid");
    const cmd = execCalls[0]!;
    expect(cmd).toContain("ffmpeg");
    expect(cmd).toContain("-f x11grab");
    expect(cmd).toContain("-i :0.0");
    expect(cmd).toContain("-video_size 1280x800");
    expect(cmd).toContain("-framerate 15");
    expect(cmd).toContain("-t 600"); // the hard ceiling (bounds a multi-day turn)
    expect(cmd).toContain("-c:v libx264"); // h264-mp4 encoder
    // Backgrounded so the launch returns (F12): nohup … & echo $! > pidfile.
    expect(cmd).toContain("nohup ffmpeg");
    expect(cmd).toContain("echo $! > /tmp/og-rec-rec-1.pid");
  });

  test("vp9-webm picks the webm container + libvpx encoder", async () => {
    const { session, execCalls } = makeMockSession();
    const proc = await startRecording(session, { recordingId: "rec-2", codec: "vp9-webm" });
    expect(proc.boxPath).toBe("/tmp/og-rec-rec-2.webm");
    expect(execCalls[0]).toContain("-c:v libvpx-vp9");
  });

  test("stopRecording SIGINTs ffmpeg and waits for the clean trailer", async () => {
    const { session, execCalls } = makeMockSession();
    const proc = await startRecording(session, { recordingId: "rec-3" });
    execCalls.length = 0;
    await stopRecording(session, proc);
    expect(execCalls[0]).toContain("kill -INT");
    expect(execCalls[0]).toContain("/tmp/og-rec-rec-3.pid");
  });

  test("readRecordingBytes reads the /tmp artifact via a DIRECT base64 exec (not readFile), computes duration, and does NOT delete the box file (F9)", async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const { session, execCalls, base64Calls } = makeMockSession({ fileBytes: bytes });
    const proc: RecordingProcess = {
      recordingId: "rec-4",
      codec: "h264-mp4",
      boxPath: "/tmp/og-rec-rec-4.mp4",
      pidFile: "/tmp/og-rec-rec-4.pid",
      dimensions: [1280, 800],
      framerate: 15,
      startedAt: Date.now() - 5_000,
      display: ":0",
    };
    const result = await readRecordingBytes(session, proc, 268_435_456);
    expect(result.bytes).toEqual(bytes);
    expect(result.contentType).toBe("video/mp4");
    expect(result.sizeBytes).toBe(3);
    expect(result.durationSeconds).toBeGreaterThanOrEqual(4); // ~5s wall clock (F14)
    // The byte transfer runs `base64 <absolute /tmp path>` over exec — the /tmp
    // path is NEVER routed through the workspace-root-scoped readFile (which would
    // reject it with "escapes the workspace root").
    expect(base64Calls.some((c) => c.includes("base64 /tmp/og-rec-rec-4.mp4"))).toBe(true);
    expect("readFile" in session).toBe(false);
    // F9: the read did NOT delete the box file (no rm in the exec calls).
    expect(execCalls.some((c) => c.includes("rm -f"))).toBe(false);
  });

  test("a /tmp artifact path is read with an absolute path that would escape the workspace-root readFile guard", async () => {
    // Regression for the finalize-path bug: the recording lives OUTSIDE the
    // workspace root (/tmp), on purpose (never the user's git tree). The byte read
    // must use raw exec, which accepts absolute paths, rather than readFile, which
    // resolves against the manifest root and 400s on anything outside it.
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const { session, base64Calls } = makeMockSession({ fileBytes: bytes });
    const proc: RecordingProcess = {
      recordingId: "rec-tmp", codec: "vp9-webm", boxPath: "/tmp/og-rec-rec-tmp.webm",
      pidFile: "/tmp/p", dimensions: [1280, 800], framerate: 15, startedAt: Date.now(), display: ":0",
    };
    const result = await readRecordingBytes(session, proc, 268_435_456);
    expect(result.bytes).toEqual(bytes);
    expect(base64Calls[0]).toContain("/tmp/og-rec-rec-tmp.webm");
  });

  test("F8: an oversize file fails max-bytes-exceeded (never uploads a truncated video)", async () => {
    const { session } = makeMockSession({ statSize: 999_999_999 });
    const proc: RecordingProcess = {
      recordingId: "rec-5", codec: "h264-mp4", boxPath: "/tmp/og-rec-rec-5.mp4",
      pidFile: "/tmp/p", dimensions: [1280, 800], framerate: 15, startedAt: Date.now(), display: ":0",
    };
    await expect(readRecordingBytes(session, proc, 1000)).rejects.toMatchObject({ reason: "max-bytes-exceeded" });
  });

  test("a missing box file fails box-death", async () => {
    const { session } = makeMockSession({ statSize: "MISSING" });
    const proc: RecordingProcess = {
      recordingId: "rec-6", codec: "h264-mp4", boxPath: "/tmp/og-rec-rec-6.mp4",
      pidFile: "/tmp/p", dimensions: [1280, 800], framerate: 15, startedAt: Date.now(), display: ":0",
    };
    await expect(readRecordingBytes(session, proc)).rejects.toMatchObject({ reason: "box-death" });
  });

  test("a session without exec/execCommand fails RecordingUnavailableError", async () => {
    const proc: RecordingProcess = {
      recordingId: "rec-7", codec: "h264-mp4", boxPath: "/tmp/x", pidFile: "/tmp/p",
      dimensions: [1280, 800], framerate: 15, startedAt: Date.now(), display: ":0",
    };
    // No exec and no execCommand: the box cannot run the stat/base64 read at all.
    await expect(readRecordingBytes({ readFile: async () => new Uint8Array() }, proc)).rejects.toBeInstanceOf(RecordingUnavailableError);
  });

  test("deleteRecordingArtifacts removes the file, pid, and log (called only post-PUT, F9)", async () => {
    const { session, execCalls } = makeMockSession();
    const proc: RecordingProcess = {
      recordingId: "rec-8", codec: "h264-mp4", boxPath: "/tmp/og-rec-rec-8.mp4", pidFile: "/tmp/og-rec-rec-8.pid",
      dimensions: [1280, 800], framerate: 15, startedAt: Date.now(), display: ":0",
    };
    await deleteRecordingArtifacts(session, proc);
    expect(execCalls[0]).toContain("rm -f /tmp/og-rec-rec-8.mp4 /tmp/og-rec-rec-8.pid /tmp/og-rec-rec-8.log");
  });

  test("storage key + codec helpers", () => {
    expect(recordingStorageKey("ws", "sess", "rec", "h264-mp4")).toBe("recordings/ws/sess/rec.mp4");
    expect(recordingStorageKey("ws", "sess", "rec", "vp9-webm")).toBe("recordings/ws/sess/rec.webm");
    expect(contentTypeForCodec("h264-mp4")).toBe("video/mp4");
    expect(contentTypeForCodec("vp9-webm")).toBe("video/webm");
    expect(extForCodec("h264-mp4")).toBe("mp4");
  });
});
