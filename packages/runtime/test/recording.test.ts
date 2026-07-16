import { describe, expect, test } from "bun:test";
import {
  startRecording,
  stopRecording,
  inspectRecordingArtifact,
  uploadRecordingArtifact,
  deleteRecordingArtifacts,
  recordingStorageKey,
  contentTypeForCodec,
  extForCodec,
  RecordingUnavailableError,
  type RecordingProcess,
} from "../src/sandbox/recording";

// A mock session recording every command, mimicking the Modal execCommand
// (formatted-string-with-banner) contract. It answers the metadata stat and the
// direct curl upload over the same command channel.
function makeMockSession(
  opts: {
    fileBytes?: Uint8Array | null;
    statSize?: number | "MISSING";
    uploadOutput?: string;
  } = {},
) {
  const execCalls: string[] = [];
  const uploadCalls: string[] = [];
  const fmt = (body: string) => `Chunk ID: a\nProcess exited with code 0\nOutput:\n${body}`;
  const session: Record<string, unknown> = {
    execCommand: async (args: { cmd: string }) => {
      execCalls.push(args.cmd);
      if (args.cmd.includes("stat -c %s")) {
        const size = opts.statSize === undefined ? (opts.fileBytes?.length ?? 0) : opts.statSize;
        return fmt(String(size));
      }
      if (args.cmd.includes("curl ")) {
        uploadCalls.push(args.cmd);
        return fmt(opts.uploadOutput ?? "OPENGENI_RECORDING_UPLOAD_OK\n");
      }
      return fmt("");
    },
  };
  return { session, execCalls, uploadCalls };
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

  test("inspectRecordingArtifact size-gates on the box without reading bytes into the worker", async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const { session, execCalls } = makeMockSession({ fileBytes: bytes });
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
    const result = await inspectRecordingArtifact(session, proc, 268_435_456);
    expect(result.contentType).toBe("video/mp4");
    expect(result.sizeBytes).toBe(3);
    expect(result.durationSeconds).toBeGreaterThanOrEqual(4); // ~5s wall clock (F14)
    expect(execCalls.some((call) => call.includes("base64 "))).toBe(false);
    expect(execCalls.some((c) => c.includes("rm -f"))).toBe(false);
  });

  test("uploadRecordingArtifact streams the absolute /tmp artifact directly to the scoped URL", async () => {
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const { session, uploadCalls } = makeMockSession({ fileBytes: bytes });
    const proc: RecordingProcess = {
      recordingId: "rec-tmp",
      codec: "vp9-webm",
      boxPath: "/tmp/og-rec-rec-tmp.webm",
      pidFile: "/tmp/p",
      dimensions: [1280, 800],
      framerate: 15,
      startedAt: Date.now(),
      display: ":0",
    };
    const result = await uploadRecordingArtifact(session, proc, {
      url: "https://storage.example/upload?sig=secret",
      requiredHeaders: {
        "content-type": "video/webm",
        "x-ms-blob-type": "BlockBlob",
      },
      maxBytes: 268_435_456,
    });
    expect(result.sizeBytes).toBe(4);
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]).toContain("--upload-file");
    expect(uploadCalls[0]).toContain("/tmp/og-rec-rec-tmp.webm");
    expect(uploadCalls[0]).toContain("content-type: video/webm");
    expect(uploadCalls[0]).toContain("x-ms-blob-type: BlockBlob");
    expect(uploadCalls[0]).toContain("https://storage.example/upload?sig=secret");
    expect(uploadCalls[0]).not.toContain("base64");
  });

  test("F8: an oversize file fails max-bytes-exceeded (never uploads a truncated video)", async () => {
    const { session } = makeMockSession({ statSize: 999_999_999 });
    const proc: RecordingProcess = {
      recordingId: "rec-5",
      codec: "h264-mp4",
      boxPath: "/tmp/og-rec-rec-5.mp4",
      pidFile: "/tmp/p",
      dimensions: [1280, 800],
      framerate: 15,
      startedAt: Date.now(),
      display: ":0",
    };
    await expect(inspectRecordingArtifact(session, proc, 1000)).rejects.toMatchObject({
      reason: "max-bytes-exceeded",
    });
  });

  test("an upload transport without the success marker fails closed", async () => {
    const { session } = makeMockSession({ fileBytes: new Uint8Array([1]), uploadOutput: "" });
    const proc: RecordingProcess = {
      recordingId: "rec-upload-failed",
      codec: "h264-mp4",
      boxPath: "/tmp/og-rec-rec-upload-failed.mp4",
      pidFile: "/tmp/p",
      dimensions: [1280, 800],
      framerate: 15,
      startedAt: Date.now(),
      display: ":0",
    };
    await expect(
      uploadRecordingArtifact(session, proc, {
        url: "https://storage.example/upload",
        requiredHeaders: { "content-type": "video/mp4" },
      }),
    ).rejects.toThrow("did not confirm success");
  });

  test("a missing box file fails box-death", async () => {
    const { session } = makeMockSession({ statSize: "MISSING" });
    const proc: RecordingProcess = {
      recordingId: "rec-6",
      codec: "h264-mp4",
      boxPath: "/tmp/og-rec-rec-6.mp4",
      pidFile: "/tmp/p",
      dimensions: [1280, 800],
      framerate: 15,
      startedAt: Date.now(),
      display: ":0",
    };
    await expect(inspectRecordingArtifact(session, proc)).rejects.toMatchObject({
      reason: "box-death",
    });
  });

  test("a session without exec/execCommand fails RecordingUnavailableError", async () => {
    const proc: RecordingProcess = {
      recordingId: "rec-7",
      codec: "h264-mp4",
      boxPath: "/tmp/x",
      pidFile: "/tmp/p",
      dimensions: [1280, 800],
      framerate: 15,
      startedAt: Date.now(),
      display: ":0",
    };
    // No exec and no execCommand: the box cannot inspect or upload the artifact.
    await expect(inspectRecordingArtifact({}, proc)).rejects.toBeInstanceOf(
      RecordingUnavailableError,
    );
  });

  test("deleteRecordingArtifacts removes the file, pid, and log (called only post-PUT, F9)", async () => {
    const { session, execCalls } = makeMockSession();
    const proc: RecordingProcess = {
      recordingId: "rec-8",
      codec: "h264-mp4",
      boxPath: "/tmp/og-rec-rec-8.mp4",
      pidFile: "/tmp/og-rec-rec-8.pid",
      dimensions: [1280, 800],
      framerate: 15,
      startedAt: Date.now(),
      display: ":0",
    };
    await deleteRecordingArtifacts(session, proc);
    expect(execCalls[0]).toContain(
      "rm -f /tmp/og-rec-rec-8.mp4 /tmp/og-rec-rec-8.pid /tmp/og-rec-rec-8.log",
    );
  });

  test("storage key + codec helpers", () => {
    expect(recordingStorageKey("ws", "sess", "rec", "h264-mp4")).toBe("recordings/ws/sess/rec.mp4");
    expect(recordingStorageKey("ws", "sess", "rec", "vp9-webm")).toBe(
      "recordings/ws/sess/rec.webm",
    );
    expect(contentTypeForCodec("h264-mp4")).toBe("video/mp4");
    expect(contentTypeForCodec("vp9-webm")).toBe("video/webm");
    expect(extForCodec("h264-mp4")).toBe("mp4");
  });
});
