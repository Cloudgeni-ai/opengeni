import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import type {
  CompleteRecordingChunksRequest,
  CreateRecordingRequest,
  CreateRecordingUploadsRequest,
  FinalizeRecordingRequest,
} from "@opengeni/contracts";
import {
  createIndexedDbRecordingChunkStore,
  createMemoryRecordingChunkStore,
  desktopSystemAudioSource,
  RecorderCaptureError,
  RecordingUploader,
  sha256Hex,
  type RecordingChunk,
  type RecordingTransport,
} from "../src/recordings";
import type { DesktopBridge } from "../src/desktop-bridge";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RECORDING = "22222222-2222-4222-8222-222222222222";

/** An in-memory server with the recording API's contract, plus a fake storage. */
function fakeServer() {
  const stored = new Map<string, Uint8Array>();
  const reserved = new Map<
    string,
    { sha256: string; byteLength: number; uploaded: boolean }
  >();
  const state = {
    created: 0,
    finalized: null as FinalizeRecordingRequest | null,
    deleted: false,
    capturing: true,
    putFailures: 0,
    dropStorageOnce: false,
    refuse: null as null | { status: number; code: string },
    calls: [] as string[],
  };
  const key = (track: number, chunk: number) => `${track}/${chunk}`;
  const refusal = () => {
    if (!state.refuse) return;
    const error = Object.assign(new Error(`refused ${state.refuse.code}`), {
      status: state.refuse.status,
      retryable: false,
      details: { code: state.refuse.code },
    });
    throw error;
  };
  const client: RecordingTransport = {
    async createRecording(
      _workspaceId: string,
      request: CreateRecordingRequest,
    ) {
      state.calls.push("create");
      refusal();
      state.created += 1;
      return { id: request.recordingId } as never;
    },
    async createRecordingUploads(
      _workspaceId: string,
      _recordingId: string,
      request: CreateRecordingUploadsRequest,
    ) {
      state.calls.push(
        `reserve:${request.trackNumber}:${request.chunks.length}`,
      );
      refusal();
      if (!state.capturing) {
        throw Object.assign(new Error("not capturing"), {
          status: 409,
          details: { code: "not_capturing" },
        });
      }
      return {
        uploads: request.chunks.map((chunk) => {
          const id = key(request.trackNumber, chunk.chunkNumber);
          const row = reserved.get(id) ?? { ...chunk, uploaded: false };
          reserved.set(id, row);
          return {
            chunkNumber: chunk.chunkNumber,
            uploaded: row.uploaded,
            url: row.uploaded ? null : `https://storage.test/${id}`,
            method: "PUT" as const,
            headers: { "x-amz-checksum-sha256": chunk.sha256 },
            expiresAt: row.uploaded ? null : new Date().toISOString(),
          };
        }),
      };
    },
    async completeRecordingChunks(
      _workspaceId: string,
      _recordingId: string,
      request: CompleteRecordingChunksRequest,
    ) {
      state.calls.push(`complete:${request.chunkNumbers.join(",")}`);
      const uploaded: number[] = [];
      const missing: number[] = [];
      for (const chunkNumber of request.chunkNumbers) {
        const id = key(request.trackNumber, chunkNumber);
        const row = reserved.get(id);
        if (row && stored.get(id)?.byteLength === row.byteLength) {
          row.uploaded = true;
          uploaded.push(chunkNumber);
        } else missing.push(chunkNumber);
      }
      return { uploaded, missing };
    },
    async finalizeRecording(
      _workspaceId: string,
      _recordingId: string,
      request: FinalizeRecordingRequest,
    ) {
      state.calls.push("finalize");
      for (const track of request.tracks) {
        for (let chunk = 0; chunk < track.chunkCount; chunk += 1) {
          if (!reserved.get(key(track.trackNumber, chunk))?.uploaded) {
            throw Object.assign(new Error("missing"), {
              status: 409,
              details: { code: "chunks_not_uploaded" },
            });
          }
        }
      }
      state.finalized = request;
      state.capturing = false;
      return {
        recording: { id: RECORDING },
        transcript: { id: "v1" },
      } as never;
    },
    async deleteRecording() {
      state.calls.push("delete");
      state.deleted = true;
    },
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (state.putFailures > 0) {
      state.putFailures -= 1;
      throw new TypeError("network down");
    }
    const id = String(url).replace("https://storage.test/", "");
    if (state.dropStorageOnce) {
      state.dropStorageOnce = false;
      return new Response(null, { status: 200 });
    }
    stored.set(id, init.body as Uint8Array);
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  return { client, fetchImpl, state, stored };
}

async function testChunk(
  trackNumber: number,
  chunkNumber: number,
  text: string,
): Promise<RecordingChunk> {
  const bytes = new TextEncoder().encode(text);
  return {
    recordingId: RECORDING,
    trackNumber,
    chunkNumber,
    bytes,
    sha256: await sha256Hex(bytes),
    startMilliseconds: chunkNumber * 5_000,
    durationMilliseconds: 5_000,
  };
}

const create: CreateRecordingRequest = {
  recordingId: RECORDING,
  tracks: [
    {
      trackNumber: 0,
      source: "microphone",
      mimeType: "audio/webm;codecs=opus",
    },
    { trackNumber: 1, source: "system", mimeType: "audio/webm;codecs=opus" },
  ],
};

function uploaderFor(
  server: ReturnType<typeof fakeServer>,
  store = createMemoryRecordingChunkStore(),
) {
  const uploader = new RecordingUploader({
    client: server.client,
    store,
    fetch: server.fetchImpl,
    sleep: async () => {},
    isCaptureActive: async () => false,
  });
  return { uploader, store };
}

describe("RecordingUploader", () => {
  test("stores chunks locally, uploads them straight to storage and finalizes with the counts", async () => {
    const server = fakeServer();
    const { uploader, store } = uploaderFor(server);
    await uploader.begin({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
    });
    await uploader.addChunk(await testChunk(0, 0, "mic-0"));
    await uploader.addChunk(await testChunk(1, 0, "sys-0"));
    await uploader.addChunk(await testChunk(0, 1, "mic-1"));
    const status = await uploader.finish(RECORDING);

    expect(status.finalized).toBe(true);
    expect(status.failed).toBeNull();
    expect(server.state.created).toBe(1);
    expect(server.state.finalized?.tracks).toEqual([
      { trackNumber: 0, chunkCount: 2 },
      { trackNumber: 1, chunkCount: 1 },
    ]);
    expect(new TextDecoder().decode(server.stored.get("0/1"))).toBe("mic-1");
    expect(await store.listRecordings()).toEqual([]);
    expect(uploader.finalized.get(RECORDING)).toBeDefined();
  });

  test("keeps retrying through network loss and loses nothing", async () => {
    const server = fakeServer();
    server.state.putFailures = 3;
    const { uploader } = uploaderFor(server);
    const seen: Array<string | null> = [];
    uploader.subscribe((status) => seen.push(status.retryingAfterError));
    await uploader.begin({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
    });
    await uploader.addChunk(await testChunk(0, 0, "a"));
    await uploader.addChunk(await testChunk(0, 1, "b"));
    const status = await uploader.finish(RECORDING);

    expect(status.finalized).toBe(true);
    expect(seen).toContain("network down");
    expect(status.retryingAfterError).toBeNull();
    expect(server.state.finalized?.tracks).toEqual([
      { trackNumber: 0, chunkCount: 2 },
      { trackNumber: 1, chunkCount: 0 },
    ]);
  });

  test("a chunk that did not reach storage is uploaded again", async () => {
    const server = fakeServer();
    server.state.dropStorageOnce = true;
    const { uploader } = uploaderFor(server);
    await uploader.begin({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
    });
    await uploader.addChunk(await testChunk(0, 0, "a"));
    const status = await uploader.finish(RECORDING);
    expect(status.finalized).toBe(true);
    expect(
      server.state.calls.filter((call) => call.startsWith("reserve")).length,
    ).toBeGreaterThan(1);
    expect(server.stored.has("0/0")).toBe(true);
  });

  test("the status says when the server has the recording, before any audio is sent", async () => {
    const server = fakeServer();
    const { uploader } = uploaderFor(server);
    const createdBeforeAudio: boolean[] = [];
    uploader.subscribe((status) => {
      if (status.created && server.stored.size === 0)
        createdBeforeAudio.push(true);
    });
    await uploader.begin({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
    });
    expect(uploader.status(RECORDING)?.created).toBe(false);
    await uploader.addChunk(await testChunk(0, 0, "a"));
    const status = await uploader.finish(RECORDING);
    expect(status.created).toBe(true);
    expect(createdBeforeAudio.length).toBeGreaterThan(0);
  });

  test("resume() finishes a recording an earlier page left behind", async () => {
    const server = fakeServer();
    const store = createMemoryRecordingChunkStore();
    // An earlier page captured two chunks, then the tab was closed before they uploaded.
    const earlier = new RecordingUploader({
      client: server.client,
      store,
      fetch: (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
      sleep: () => new Promise(() => {}),
    });
    await earlier.begin({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
    });
    await earlier.addChunk(await testChunk(0, 0, "a"));
    await earlier.addChunk(await testChunk(1, 0, "b"));
    earlier.dispose();
    expect((await store.listChunks(RECORDING)).length).toBe(2);

    const { uploader } = uploaderFor(server, store);
    expect(await uploader.resume()).toEqual([RECORDING]);
    const status = await uploader.finish(RECORDING);
    expect(status.finalized).toBe(true);
    expect(server.state.finalized?.endedAt).toBeString();
    expect(server.state.finalized?.tracks).toEqual([
      { trackNumber: 0, chunkCount: 1 },
      { trackNumber: 1, chunkCount: 1 },
    ]);
  });

  test("resume() leaves a recording that is still being captured alone", async () => {
    const server = fakeServer();
    const store = createMemoryRecordingChunkStore();
    const live = new RecordingUploader({
      client: server.client,
      store,
      fetch: server.fetchImpl,
      sleep: async () => {},
    });
    await live.begin({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
    });
    const other = new RecordingUploader({
      client: server.client,
      store,
      fetch: server.fetchImpl,
      isCaptureActive: async () => true,
    });
    expect(await other.resume()).toEqual([]);
    expect((await store.getRecording(RECORDING))?.phase).toBe("capturing");
  });

  test("a refusal retrying cannot fix fails the upload and keeps the local copy", async () => {
    const server = fakeServer();
    server.state.refuse = { status: 403, code: "forbidden" };
    const { uploader, store } = uploaderFor(server);
    await uploader.begin({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
    });
    await uploader.addChunk(await testChunk(0, 0, "a"));
    const status = await uploader.finish(RECORDING);
    expect(status.finalized).toBe(false);
    expect(status.failed?.code).toBe("forbidden");
    expect((await store.listChunks(RECORDING)).length).toBe(1);
  });

  test("a sign-in that is not valid yet is retried, not failed", async () => {
    const server = fakeServer();
    server.state.refuse = { status: 401, code: "unauthorized" };
    // Backoff has to yield here, or retrying the refusal would never let the test run.
    const uploader = new RecordingUploader({
      client: server.client,
      store: createMemoryRecordingChunkStore(),
      fetch: server.fetchImpl,
      sleep: () => new Promise((done) => setTimeout(done, 1)),
      isCaptureActive: async () => false,
    });
    const seen: Array<string | null> = [];
    uploader.subscribe((status) => seen.push(status.retryingAfterError));
    await uploader.begin({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
    });
    await uploader.addChunk(await testChunk(0, 0, "a"));
    for (let attempt = 0; attempt < 50 && !seen.some(Boolean); attempt += 1) {
      await new Promise((done) => setTimeout(done, 1));
    }
    // The app signs in again (or its token loads): the same upload carries on.
    server.state.refuse = null;
    const status = await uploader.finish(RECORDING);
    expect(seen.some((error) => error?.includes("unauthorized"))).toBe(true);
    expect(status.failed).toBeNull();
    expect(status.finalized).toBe(true);
  });

  test("a recording stopped before any audio is removed instead of finalized", async () => {
    const server = fakeServer();
    const { uploader, store } = uploaderFor(server);
    await uploader.begin({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
    });
    const status = await uploader.finish(RECORDING);
    expect(status.discarded).toBe(true);
    expect(status.finalized).toBe(false);
    expect(status.failed).toBeNull();
    expect(server.state.calls).not.toContain("finalize");
    expect(server.state.deleted).toBe(true);
    expect(await store.getRecording(RECORDING)).toBeNull();
  });

  test("resume removes an earlier run's recording that never captured audio", async () => {
    const server = fakeServer();
    const store = createMemoryRecordingChunkStore();
    const first = uploaderFor(server, store).uploader;
    await first.begin({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
    });
    for (
      let attempt = 0;
      attempt < 20 && server.state.created === 0;
      attempt += 1
    ) {
      await new Promise((done) => setTimeout(done, 1));
    }
    // The app was killed while capturing: a new run finds it still "capturing".
    const next = uploaderFor(server, store).uploader;
    expect(await next.resume()).toEqual([RECORDING]);
    for (
      let attempt = 0;
      attempt < 50 && !next.status(RECORDING)?.discarded;
      attempt += 1
    ) {
      await new Promise((done) => setTimeout(done, 1));
    }
    expect(next.status(RECORDING)?.discarded).toBe(true);
    expect(server.state.deleted).toBe(true);
    expect(await store.listRecordings()).toEqual([]);
  });

  test("discard removes the local copy and the server's", async () => {
    const server = fakeServer();
    const { uploader, store } = uploaderFor(server);
    await uploader.begin({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
    });
    await uploader.addChunk(await testChunk(0, 0, "a"));
    // Let the background pass create it on the server.
    for (
      let attempt = 0;
      attempt < 20 && server.state.created === 0;
      attempt += 1
    ) {
      await new Promise((done) => setTimeout(done, 1));
    }
    await uploader.discard(RECORDING);
    expect(await store.getRecording(RECORDING)).toBeNull();
    expect(server.state.deleted).toBe(true);
  });

  test("the IndexedDB store survives a reopen and keeps chunks in order", async () => {
    const factory = new IDBFactory();
    const first = createIndexedDbRecordingChunkStore({
      indexedDB: factory,
      databaseName: "t",
    });
    const server = fakeServer();
    const capture = new RecordingUploader({
      client: server.client,
      store: first,
      fetch: (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
      sleep: () => new Promise(() => {}),
    });
    await capture.begin({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
    });
    await capture.addChunk(await testChunk(1, 0, "s0"));
    await capture.addChunk(await testChunk(0, 1, "m1"));
    await capture.addChunk(await testChunk(0, 0, "m0"));
    capture.dispose();

    // A new page opens the same database.
    const reopened = createIndexedDbRecordingChunkStore({
      indexedDB: factory,
      databaseName: "t",
    });
    const chunks = await reopened.listChunks(RECORDING);
    expect(
      chunks.map((item) => `${item.trackNumber}/${item.chunkNumber}`),
    ).toEqual(["0/0", "0/1", "1/0"]);
    expect(chunks[0]).not.toHaveProperty("bytes");
    expect(chunks[0]!.byteLength).toBe(2);
    expect(
      new TextDecoder().decode((await reopened.readChunk(RECORDING, 0, 0))!),
    ).toBe("m0");
    expect((await reopened.getRecording(RECORDING))?.chunkCounts).toEqual({
      0: 2,
      1: 1,
    });

    const { uploader } = uploaderFor(server, reopened);
    await uploader.resume();
    expect((await uploader.finish(RECORDING)).finalized).toBe(true);
    expect(await reopened.listRecordings()).toEqual([]);
    expect(await reopened.listChunks(RECORDING)).toEqual([]);
    expect(await reopened.readChunk(RECORDING, 0, 0)).toBeNull();
  });

  test("an IndexedDB store from the first version keeps its chunks after the upgrade", async () => {
    const factory = new IDBFactory();
    // The first version's layout: chunk records carried their bytes.
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("old", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("recordings", { keyPath: "recordingId" });
        db.createObjectStore("chunks", {
          keyPath: ["recordingId", "trackNumber", "chunkNumber"],
        }).createIndex("recordingId", "recordingId");
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["chunks"], "readwrite");
        tx.objectStore("chunks").put({
          recordingId: RECORDING,
          trackNumber: 0,
          chunkNumber: 0,
          bytes: new TextEncoder().encode("old"),
          sha256: "x",
          startMilliseconds: 0,
          durationMilliseconds: 5_000,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    const store = createIndexedDbRecordingChunkStore({
      indexedDB: factory,
      databaseName: "old",
    });
    expect(await store.listChunks(RECORDING)).toEqual([
      {
        recordingId: RECORDING,
        trackNumber: 0,
        chunkNumber: 0,
        byteLength: 3,
        sha256: "x",
        startMilliseconds: 0,
        durationMilliseconds: 5_000,
      },
    ]);
    expect(
      new TextDecoder().decode((await store.readChunk(RECORDING, 0, 0))!),
    ).toBe("old");
  });
});

describe("desktopSystemAudioSource", () => {
  type Frame = {
    numberOfFrames: number;
    sampleRate: number;
    timestamp: number;
    data: Float32Array;
  };

  function fakeDesktop(
    start: () => Promise<{ captureId: string; sampleRate: number }>,
  ) {
    const sampleListeners = new Set<
      (id: string, samples: Float32Array) => void
    >();
    const endedListeners = new Set<(id: string, error: unknown) => void>();
    const stopped: string[] = [];
    const bridge = {
      version: 1,
      capabilities: ["systemAudio"],
      systemAudio: {
        start,
        stop: async (id: string) => {
          stopped.push(id);
        },
        onSamples: (listener: (id: string, samples: Float32Array) => void) => {
          sampleListeners.add(listener);
          return () => sampleListeners.delete(listener);
        },
        onEnded: (listener: (id: string, error: unknown) => void) => {
          endedListeners.add(listener);
          return () => endedListeners.delete(listener);
        },
      },
    } as unknown as DesktopBridge;
    return {
      bridge,
      stopped,
      listeners: () => sampleListeners.size + endedListeners.size,
      samples: (id: string, values: number[]) => {
        for (const listener of sampleListeners)
          listener(id, new Float32Array(values));
      },
      end: (id: string) => {
        for (const listener of [...endedListeners]) listener(id, null);
      },
    };
  }

  function withMediaGlobals<T>(
    run: (frames: Frame[], tracks: EventTarget[]) => Promise<T>,
  ) {
    const frames: Frame[] = [];
    const tracks: EventTarget[] = [];
    const scope = globalThis as Record<string, unknown>;
    const saved = ["MediaStreamTrackGenerator", "AudioData", "MediaStream"].map(
      (name) => [name, scope[name]] as const,
    );
    scope.MediaStreamTrackGenerator = class extends EventTarget {
      readyState = "live";
      writable = {
        getWriter: () => ({
          write: async (frame: Frame) => {
            frames.push(frame);
          },
          close: async () => undefined,
        }),
      };
      constructor() {
        super();
        tracks.push(this);
      }
      stop() {
        this.readyState = "ended";
      }
    };
    scope.AudioData = class {
      constructor(init: Frame) {
        Object.assign(this, init);
      }
    };
    scope.MediaStream = class {
      constructor(readonly members: unknown[]) {}
    };
    return run(frames, tracks).finally(() => {
      for (const [name, value] of saved) scope[name] = value;
    });
  }

  test("none outside a desktop app that can record other apps' audio", () => {
    expect(desktopSystemAudioSource(null)).toBeNull();
    expect(
      desktopSystemAudioSource({
        version: 1,
        capabilities: [],
      } as unknown as DesktopBridge),
    ).toBeNull();
  });

  test("turns the app's samples into a track, keeping samples that beat the start", async () => {
    await withMediaGlobals(async (frames, tracks) => {
      let desktop!: ReturnType<typeof fakeDesktop>;
      desktop = fakeDesktop(async () => {
        // The app's first samples can arrive before start() resolves.
        desktop.samples("cap-1", [0.1, 0.2]);
        desktop.samples("other", [9]);
        return { captureId: "cap-1", sampleRate: 4 };
      });
      const source = desktopSystemAudioSource(desktop.bridge);
      expect(source?.kind).toBe("desktop");
      const capture = await source!.open();
      desktop.samples("cap-1", [0.3, 0.4, 0.5, 0.6]);
      expect(frames.map((frame) => [...frame.data])).toEqual([
        [0.1, 0.2].map(Math.fround),
        [0.3, 0.4, 0.5, 0.6].map(Math.fround),
      ]);
      // Timestamps in microseconds follow the samples: 2 samples at 4 Hz.
      expect(frames.map((frame) => frame.timestamp)).toEqual([0, 500_000]);
      let ended = false;
      tracks[0]!.addEventListener("ended", () => {
        ended = true;
      });
      desktop.end("cap-1");
      expect(ended).toBe(true);
      capture.stop();
      expect(desktop.stopped).toEqual(["cap-1"]);
      expect(desktop.listeners()).toBe(0);
    });
  });

  test("a refused start becomes the recorder's system audio error", async () => {
    await withMediaGlobals(async () => {
      const desktop = fakeDesktop(async () => {
        throw {
          code: "permission_denied",
          message: "Allow it in System Settings.",
        };
      });
      const error = await desktopSystemAudioSource(desktop.bridge)!
        .open()
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(RecorderCaptureError);
      expect(error).toMatchObject({
        code: "system_audio_unavailable",
        message: "Allow it in System Settings.",
      });
      expect(desktop.listeners()).toBe(0);
    });
  });
});
