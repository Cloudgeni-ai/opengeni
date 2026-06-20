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

// A mock session recording every command + readFile, mimicking the Modal
// execCommand (formatted-string) contract.
function makeMockSession(opts: { fileBytes?: Uint8Array | null; statSize?: number | "MISSING" } = {}) {
  const execCalls: string[] = [];
  const readFileCalls: string[] = [];
  const fmt = (body: string) => `Chunk ID: a\nProcess exited with code 0\nOutput:\n${body}`;
  const session: Record<string, unknown> = {
    execCommand: async (args: { cmd: string }) => {
      execCalls.push(args.cmd);
      if (args.cmd.includes("stat -c %s")) {
        const size = opts.statSize === undefined ? (opts.fileBytes?.length ?? 0) : opts.statSize;
        return fmt(String(size));
      }
      return fmt("");
    },
    readFile: async (args: { path: string; maxBytes?: number }) => {
      readFileCalls.push(args.path);
      if (opts.fileBytes === null) return new Uint8Array();
      return opts.fileBytes ?? new Uint8Array([1, 2, 3, 4, 5]);
    },
  };
  return { session, execCalls, readFileCalls };
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

  test("readRecordingBytes reads via readFile, computes duration, and does NOT delete the box file (F9)", async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const { session, execCalls, readFileCalls } = makeMockSession({ fileBytes: bytes });
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
    expect(readFileCalls).toContain("/tmp/og-rec-rec-4.mp4");
    // F9: the read did NOT delete the box file (no rm in the exec calls).
    expect(execCalls.some((c) => c.includes("rm -f"))).toBe(false);
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

  test("a session without readFile fails RecordingUnavailableError", async () => {
    const proc: RecordingProcess = {
      recordingId: "rec-7", codec: "h264-mp4", boxPath: "/tmp/x", pidFile: "/tmp/p",
      dimensions: [1280, 800], framerate: 15, startedAt: Date.now(), display: ":0",
    };
    await expect(readRecordingBytes({ execCommand: async () => "0" }, proc)).rejects.toBeInstanceOf(RecordingUnavailableError);
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
