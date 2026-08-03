import { describe, expect, test } from "bun:test";
import {
  IndexedDbVoiceRecordingStore,
  VoiceRecordingChunkConflictError,
  VoiceRecordingChunkSequenceError,
  VoiceRecordingStorageUnavailableError,
  createVoiceRecordingManifest,
  planVoiceRecordingChunkCommit,
  prepareVoiceRecordingChunk,
} from "../src/voice-recording-store";

const createdAt = "2026-08-03T21:00:00.000Z";

describe("durable voice recording storage primitives", () => {
  test("creates a stable manifest with explicit lifecycle states", () => {
    const manifest = createVoiceRecordingManifest({
      recordingId: "recording-1",
      workspaceId: "workspace-1",
      mimeType: "audio/webm;codecs=opus",
      createdAt,
    });

    expect(manifest).toMatchObject({
      version: 1,
      recordingId: "recording-1",
      workspaceId: "workspace-1",
      codec: "opus",
      captureState: "capturing",
      uploadState: "pending",
      transcriptionState: "pending",
      finalizationState: "pending",
      ownerId: null,
      ownerHeartbeatAt: null,
      transcriptText: null,
      nextChunkNumber: 0,
      chunkCount: 0,
      totalBytes: 0,
      totalDurationMilliseconds: 0,
    });
  });

  test("hashes chunk audio and advances ordered manifest totals", async () => {
    const manifest = createVoiceRecordingManifest({
      recordingId: "recording-1",
      workspaceId: "workspace-1",
      mimeType: "audio/webm;codecs=opus",
      createdAt,
    });
    const chunk = await prepareVoiceRecordingChunk({
      recordingId: manifest.recordingId,
      chunkNumber: 0,
      capturedAt: "2026-08-03T21:00:02.000Z",
      startMilliseconds: 0,
      durationMilliseconds: 2_000,
      mimeType: manifest.mimeType,
      audio: new Blob([new Uint8Array([1, 2, 3])], { type: manifest.mimeType }),
    });
    const result = planVoiceRecordingChunkCommit({
      manifest,
      chunk,
      existingChunk: null,
    });

    expect(chunk.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(chunk.byteLength).toBe(3);
    expect(result.deduplicated).toBe(false);
    expect(result.manifest).toMatchObject({
      nextChunkNumber: 1,
      chunkCount: 1,
      totalBytes: 3,
      totalDurationMilliseconds: 2_000,
    });
  });

  test("deduplicates an exact persisted chunk without advancing the manifest", async () => {
    const manifest = createVoiceRecordingManifest({
      recordingId: "recording-1",
      workspaceId: "workspace-1",
      mimeType: "audio/webm",
      createdAt,
    });
    const chunk = await prepareVoiceRecordingChunk({
      recordingId: manifest.recordingId,
      chunkNumber: 0,
      capturedAt: createdAt,
      startMilliseconds: 0,
      durationMilliseconds: 1_000,
      mimeType: manifest.mimeType,
      audio: new Blob(["audio"], { type: manifest.mimeType }),
    });
    const result = planVoiceRecordingChunkCommit({ manifest, chunk, existingChunk: chunk });

    expect(result.deduplicated).toBe(true);
    expect(result.manifest).toBe(manifest);
    expect(result.chunk).toBe(chunk);
  });

  test("rejects conflicting duplicates and gaps before storage acknowledgement", async () => {
    const manifest = createVoiceRecordingManifest({
      recordingId: "recording-1",
      workspaceId: "workspace-1",
      mimeType: "audio/webm",
      createdAt,
    });
    const first = await prepareVoiceRecordingChunk({
      recordingId: manifest.recordingId,
      chunkNumber: 0,
      capturedAt: createdAt,
      startMilliseconds: 0,
      durationMilliseconds: 1_000,
      mimeType: manifest.mimeType,
      audio: new Blob(["first"], { type: manifest.mimeType }),
    });
    const conflicting = await prepareVoiceRecordingChunk({
      recordingId: manifest.recordingId,
      chunkNumber: 0,
      capturedAt: createdAt,
      startMilliseconds: 0,
      durationMilliseconds: 1_000,
      mimeType: manifest.mimeType,
      audio: new Blob(["different"], { type: manifest.mimeType }),
    });
    const gap = await prepareVoiceRecordingChunk({
      recordingId: manifest.recordingId,
      chunkNumber: 2,
      capturedAt: createdAt,
      startMilliseconds: 2_000,
      durationMilliseconds: 1_000,
      mimeType: manifest.mimeType,
      audio: new Blob(["gap"], { type: manifest.mimeType }),
    });

    expect(() =>
      planVoiceRecordingChunkCommit({ manifest, chunk: conflicting, existingChunk: first }),
    ).toThrow(VoiceRecordingChunkConflictError);
    expect(() =>
      planVoiceRecordingChunkCommit({ manifest, chunk: gap, existingChunk: null }),
    ).toThrow(VoiceRecordingChunkSequenceError);
  });

  test("fails closed when IndexedDB is unavailable", () => {
    expect(() => new IndexedDbVoiceRecordingStore({ indexedDB: null })).toThrow(
      VoiceRecordingStorageUnavailableError,
    );
  });
});
