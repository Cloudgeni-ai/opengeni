import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BrowserRecordingSummary } from "@opengeni/contracts";
import {
  BROWSER_RECORDING_LEGACY_EXPORT_TIMEOUT_MS,
  BROWSER_RECORDING_STAGING_TTL_MS,
  BROWSER_RECORDING_UPLOAD_WAIT_MS,
  stageBrowserRecordingBundle,
} from "../src/browser-recording-save";

const recordingId = randomUUID();
const sha256 = "b".repeat(64);
const bundleKey = `workspaces/w/browser-recordings/${recordingId}/bundle`;
const stagedKeys = [`workspaces/w/browser-recordings/${recordingId}/op/video.mp4`];

function summary(bundle: BrowserRecordingSummary["bundle"]): BrowserRecordingSummary {
  return {
    recordingId,
    state: "stopped",
    startedAt: "2026-10-23T20:00:00.000Z",
    stoppedAt: "2026-10-23T20:12:00.000Z",
    stopReason: "requested",
    durationMs: 720_000,
    frameCount: 10,
    frameBytes: 40,
    actionCount: 2,
    bundle,
    streamError: null,
  };
}

type UploadCall = { waitMs: number; replace?: boolean | undefined };

function harness(options: {
  uploadStates?: Array<"uploading" | "uploaded" | null>;
  stored?: Array<Uint8Array | null>;
  bundle?: BrowserRecordingSummary["bundle"];
  receiptSize?: number;
}) {
  const uploadStates = [...(options.uploadStates ?? [])];
  const stored = [...(options.stored ?? [])];
  const uploads: UploadCall[] = [];
  const exports: Array<{ timeoutMs?: number | undefined }> = [];
  const scheduled: Array<{ keys: string[]; deleteAfter: Date }> = [];
  const bundle = options.bundle === undefined ? { sizeBytes: 3, sha256 } : options.bundle;
  const sessionClient = {
    stopRecording: async () => summary(bundle),
    uploadRecording: async (request: UploadCall) => {
      uploads.push({ waitMs: request.waitMs, replace: request.replace });
      const state = uploadStates.length > 0 ? uploadStates.shift()! : "uploaded";
      if (state === null) return null;
      return { recordingId, state, sizeBytes: options.receiptSize ?? 3, sha256 };
    },
    exportRecording: async (_request: unknown, exportOptions: { timeoutMs?: number } = {}) => {
      exports.push(exportOptions);
      return { recordingId, sizeBytes: options.receiptSize ?? 3, sha256 };
    },
  };
  const objectStorage = {
    maxSinglePutSizeBytes: 1_000,
    createPutUrl: async () => ({
      url: "https://storage.example/bundle?sig=1",
      requiredHeaders: {},
      expiresAt: new Date("2026-10-23T21:00:00.000Z"),
    }),
    getObjectBytes: async () => {
      const bytes = stored.length > 0 ? stored.shift()! : Uint8Array.from([1, 2, 3]);
      return bytes ? { bytes } : null;
    },
  };
  return {
    uploads,
    exports,
    scheduled,
    stage: async (withScheduler = true) =>
      await stageBrowserRecordingBundle({
        sessionClient: sessionClient as never,
        objectStorage: objectStorage as never,
        recordingId,
        bundleKey,
        stagedKeys,
        audience: "public",
        uploadTtlSeconds: 1_200,
        now: () => 1_000,
        scheduleDeletion: withScheduler
          ? async (keys, deleteAfter) => {
              scheduled.push({ keys, deleteAfter });
            }
          : undefined,
      }),
  };
}

describe("stageBrowserRecordingBundle", () => {
  test("a slow upload answers without the bundle after a bounded wait, staged keys already scheduled", async () => {
    const run = harness({ uploadStates: ["uploading"] });
    const staged = await run.stage();
    expect(staged.bundle).toBeNull();
    expect(staged.recording.recordingId).toBe(recordingId);
    expect(run.uploads).toEqual([{ waitMs: BROWSER_RECORDING_UPLOAD_WAIT_MS, replace: undefined }]);
    expect(run.exports).toEqual([]);
    expect(run.scheduled).toEqual([
      {
        keys: [bundleKey, ...stagedKeys],
        deleteAfter: new Date(1_000 + BROWSER_RECORDING_STAGING_TTL_MS),
      },
    ]);
  });

  test("a landed upload returns the stored bundle", async () => {
    const run = harness({ uploadStates: ["uploaded"] });
    const staged = await run.stage();
    expect([...staged.bundle!]).toEqual([1, 2, 3]);
    expect(run.uploads).toHaveLength(1);
  });

  test("a finished upload whose object is gone is uploaded again", async () => {
    const missing = Array<Uint8Array | null>(8).fill(null);
    const run = harness({ uploadStates: ["uploaded", "uploading"], stored: missing });
    const staged = await run.stage();
    expect(staged.bundle).toBeNull();
    expect(run.uploads.map((call) => call.replace)).toEqual([undefined, true]);
  });

  test("a controller without background uploads is waited on in one bounded call", async () => {
    const run = harness({ uploadStates: [null] });
    const staged = await run.stage();
    expect(staged.bundle).not.toBeNull();
    expect(run.exports).toEqual([{ timeoutMs: BROWSER_RECORDING_LEGACY_EXPORT_TIMEOUT_MS }]);
  });

  test("without durable deletion the save waits for the whole upload and schedules nothing", async () => {
    const run = harness({});
    const staged = await run.stage(false);
    expect(staged.bundle).not.toBeNull();
    expect(run.uploads).toEqual([]);
    expect(run.exports).toHaveLength(1);
    expect(run.scheduled).toEqual([]);
  });

  test("refuses an empty recording and a mismatched upload receipt", async () => {
    await expect(harness({ bundle: null }).stage()).rejects.toThrow("nothing to save");
    await expect(harness({ receiptSize: 4 }).stage()).rejects.toThrow(
      "browser controller returned another recording export",
    );
    await expect(harness({ bundle: { sizeBytes: 5_000, sha256 } }).stage()).rejects.toMatchObject({
      status: 413,
    });
  });
});
