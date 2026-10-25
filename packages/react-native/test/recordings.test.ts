import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AppendRecordingLiveSegmentsRequest,
  CreateRecordingRequest,
  CreateRecordingUploadsRequest,
  FinalizeRecordingRequest,
  RecordingLiveSession,
} from "@opengeni/contracts";
import type { LiveWebSocket, RecorderSnapshot, RecordingTransport } from "@opengeni/sdk/recordings";
import { readAdtsFrame, wholeAdtsFrames } from "../src/recordings/adts";
import {
  createFileRecordingChunkStore,
  parseRecordingChunkFileName,
  recordingChunkFileName,
  type RecordingFileSystem,
} from "../src/recordings/file-store";
import {
  createNativeRecorder,
  type NativeAudioCapture,
  type NativeAudioChunkEvent,
  type NativeAudioPcmEvent,
  type NativeAudioStateEvent,
} from "../src/recordings/native-recorder";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RECORDING = "22222222-2222-4222-8222-222222222222";

const nodeFs: RecordingFileSystem = {
  async list(directory) {
    return await readdir(directory).catch(() => []);
  },
  async readBytes(path) {
    return await readFile(path).then(
      (buffer) => new Uint8Array(buffer),
      () => null,
    );
  },
  async readText(path) {
    return await readFile(path, "utf8").catch(() => null);
  },
  async writeBytes(path, bytes) {
    await writeFile(`${path}.tmp`, bytes);
    await rename(`${path}.tmp`, path);
  },
  async writeText(path, text) {
    await writeFile(`${path}.tmp`, text);
    await rename(`${path}.tmp`, path);
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
  async makeDirectory(path) {
    await mkdir(path, { recursive: true });
  },
};

const sha256 = async (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** One ADTS frame: AAC-LC, 48 kHz, mono, `payload` bytes after the 7-byte header. */
function adtsFrame(payload = 20): Uint8Array {
  const length = 7 + payload;
  const frame = new Uint8Array(length);
  frame.set([
    0xff,
    0xf1,
    (1 << 6) | (3 << 2),
    (1 << 6) | ((length >> 11) & 0x03),
    (length >> 3) & 0xff,
    ((length & 0x07) << 5) | 0x1f,
    0xfc,
  ]);
  return frame;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

async function storeIn() {
  const root = await mkdtemp(join(tmpdir(), "og-recordings-"));
  return { root, store: createFileRecordingChunkStore({ fs: nodeFs, root, sha256 }) };
}

const create: CreateRecordingRequest = {
  recordingId: RECORDING,
  tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/aac" }],
};

describe("ADTS frames", () => {
  test("reads frame headers and keeps only whole frames", () => {
    const frame = adtsFrame();
    expect(readAdtsFrame(frame, 0)).toEqual({
      offset: 0,
      length: 27,
      samples: 1024,
      sampleRate: 48_000,
    });
    const cut = concat([adtsFrame(), adtsFrame(), adtsFrame().slice(0, 10)]);
    expect(wholeAdtsFrames(cut)).toEqual({ byteLength: 54, frames: 2, durationMilliseconds: 43 });
    expect(wholeAdtsFrames(new Uint8Array([1, 2, 3])).frames).toBe(0);
  });
});

describe("file recording store", () => {
  test("names chunk files after their details and lists them without reading them", async () => {
    const name = recordingChunkFileName({
      trackNumber: 0,
      chunkNumber: 12,
      startMilliseconds: 60_000,
      durationMilliseconds: 5_000,
      byteLength: 40_000,
      sha256: "a".repeat(64),
    });
    expect(name).toBe(`t0-c000012-s60000-d5000-b40000-${"a".repeat(64)}.chunk`);
    expect(parseRecordingChunkFileName(RECORDING, name)?.chunkNumber).toBe(12);
    expect(parseRecordingChunkFileName(RECORDING, "recording.json")).toBeNull();

    const { root, store } = await storeIn();
    await store.putRecording({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
      created: false,
      phase: "capturing",
      endedAt: null,
      chunkCounts: { 0: 0 },
      updatedAt: 1,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    for (const chunkNumber of [1, 0]) {
      await store.putChunk({
        recordingId: RECORDING,
        trackNumber: 0,
        chunkNumber,
        bytes,
        sha256: await sha256(bytes),
        startMilliseconds: chunkNumber * 5_000,
        durationMilliseconds: 5_000,
      });
    }
    const listed = await store.listChunks(RECORDING);
    expect(listed.map((chunk) => [chunk.chunkNumber, chunk.byteLength])).toEqual([
      [0, 3],
      [1, 3],
    ]);
    expect(await store.readChunk(RECORDING, 0, 1)).toEqual(bytes);
    await store.deleteChunks(RECORDING, 0, [0]);
    expect((await store.listChunks(RECORDING)).map((chunk) => chunk.chunkNumber)).toEqual([1]);
    expect(await store.readChunk(RECORDING, 0, 0)).toBeNull();
    expect((await store.listRecordings()).map((recording) => recording.recordingId)).toEqual([
      RECORDING,
    ]);
    await store.deleteRecording(RECORDING);
    expect(await readdir(root)).toEqual([]);
  });

  test("recovery keeps a half-written chunk up to its last whole frame and counts it", async () => {
    const { root, store } = await storeIn();
    await store.putRecording({
      workspaceId: WORKSPACE,
      recordingId: RECORDING,
      create,
      created: true,
      phase: "capturing",
      endedAt: null,
      chunkCounts: { 0: 1 },
      updatedAt: 1234,
    });
    const folder = join(root, RECORDING);
    const whole = concat([adtsFrame(), adtsFrame()]);
    // Chunk 1 finished but the app died before JavaScript recorded it; chunk 2 was cut short.
    await writeFile(
      join(
        folder,
        recordingChunkFileName({
          trackNumber: 0,
          chunkNumber: 1,
          startMilliseconds: 5_000,
          durationMilliseconds: 43,
          byteLength: whole.length,
          sha256: await sha256(whole),
        }),
      ),
      whole,
    );
    await writeFile(
      join(folder, "t0-c000002-s5043.part"),
      concat([whole, adtsFrame().slice(0, 9)]),
    );
    await writeFile(join(folder, "t0-c000003-s5086.part"), new Uint8Array([0xff]));
    await store.recover();
    const chunks = await store.listChunks(RECORDING);
    expect(
      chunks.map((chunk) => [chunk.chunkNumber, chunk.startMilliseconds, chunk.byteLength]),
    ).toEqual([
      [1, 5_000, 54],
      [2, 5_043, 54],
    ]);
    expect(chunks[1]!.sha256).toBe(await sha256(whole));
    expect((await readdir(folder)).filter((name) => name.endsWith(".part"))).toEqual([]);
    const recording = await store.getRecording(RECORDING);
    expect(recording?.chunkCounts).toEqual({ 0: 3 });
    expect(recording?.updatedAt).toBe(1234);
  });
});

/** A native module whose chunks the test writes into the recording's folder. */
function fakeNative(directoryOf: (recordingId: string) => string) {
  const listeners = {
    onChunk: new Set<(event: NativeAudioChunkEvent) => void>(),
    onState: new Set<(event: NativeAudioStateEvent) => void>(),
    onError: new Set<(event: { recordingId: string; code: string; message: string }) => void>(),
    onPcm: new Set<(event: NativeAudioPcmEvent) => void>(),
  };
  const state = {
    active: null as string | null,
    next: 0,
    elapsed: 0,
    paused: false,
    livePcm: false,
    started: null as null | Record<string, unknown>,
  };
  const writeChunk = async (options: { emit?: boolean } = {}) => {
    const recordingId = state.active!;
    const bytes = concat([adtsFrame(), adtsFrame()]);
    const chunkNumber = state.next++;
    const event: NativeAudioChunkEvent = {
      recordingId,
      trackNumber: 0,
      chunkNumber,
      startMilliseconds: chunkNumber * 5_000,
      durationMilliseconds: 5_000,
      byteLength: bytes.length,
      sha256: await sha256(bytes),
      fileName: "",
    };
    event.fileName = recordingChunkFileName(event);
    await mkdir(directoryOf(recordingId), { recursive: true });
    await writeFile(join(directoryOf(recordingId), event.fileName), bytes);
    state.elapsed = (chunkNumber + 1) * 5_000;
    if (options.emit !== false) for (const listener of listeners.onChunk) listener(event);
    return event;
  };
  const native: NativeAudioCapture = {
    async start(options) {
      state.active = options.recordingId;
      state.started = options;
      return { sampleRate: 48_000, inputName: "iPhone Microphone" };
    },
    pause: () => {
      state.paused = true;
    },
    async resume() {
      state.paused = false;
    },
    async stop() {
      // The last chunk comes back from stop() only, before its event: it must still be saved.
      const last = await writeChunk({ emit: false });
      state.active = null;
      return last;
    },
    async cancel() {
      state.active = null;
    },
    elapsedMilliseconds: () => state.elapsed,
    level: () => 0.5,
    activeRecordingId: () => state.active,
    setLivePcm(enabled: boolean) {
      state.livePcm = enabled;
    },
    addListener(event: "onChunk" | "onState" | "onError" | "onPcm", listener: never) {
      const set = listeners[event] as Set<unknown>;
      set.add(listener);
      return { remove: () => set.delete(listener) };
    },
  } as NativeAudioCapture;
  return {
    native,
    state,
    writeChunk,
    emitState: (event: NativeAudioStateEvent) => {
      for (const listener of listeners.onState) listener(event);
    },
    /** A tenth of a second at 16 kHz, as the native tap sends it. */
    emitPcm: (recordedMilliseconds: number, value = 1_000) => {
      const samples = new Int16Array(1_600).fill(value);
      const bytes = new Uint8Array(samples.buffer);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      for (const listener of listeners.onPcm) {
        listener({
          recordingId: state.active!,
          data: btoa(binary),
          sampleRate: 16_000,
          recordedMilliseconds,
        });
      }
    },
    pcmListeners: () => listeners.onPcm.size,
  };
}

function fakeServer() {
  const stored = new Map<string, Uint8Array>();
  const state = {
    created: null as CreateRecordingRequest | null,
    finalized: null as FinalizeRecordingRequest | null,
    uploaded: new Set<number>(),
  };
  const client: RecordingTransport = {
    async createRecording(_workspaceId, request) {
      state.created = request;
      return { id: request.recordingId } as never;
    },
    async createRecordingUploads(
      _workspaceId,
      _recordingId,
      request: CreateRecordingUploadsRequest,
    ) {
      return {
        uploads: request.chunks.map((chunk) => ({
          chunkNumber: chunk.chunkNumber,
          uploaded: false,
          url: `https://storage.test/${chunk.chunkNumber}`,
          headers: {},
        })),
      } as never;
    },
    async completeRecordingChunks(_workspaceId, _recordingId, request) {
      for (const chunk of request.chunkNumbers) state.uploaded.add(chunk);
      return { uploaded: request.chunkNumbers, missing: [] } as never;
    },
    async finalizeRecording(_workspaceId, _recordingId, request) {
      state.finalized = request;
      return {} as never;
    },
    async deleteRecording() {},
  };
  const fetch = (async (url: string, init: { body: Uint8Array }) => {
    stored.set(url, init.body);
    return new Response(null, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { client, state, stored, fetch };
}

class FakeLiveSocket implements LiveWebSocket {
  static opened: FakeLiveSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeLiveSocket.opened.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
    this.receive({ message_type: "session_started", session_id: "s" });
  }
  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    if (this.sent.at(-1)!.commit === true) {
      queueMicrotask(() =>
        this.receive({
          message_type: "committed_transcript_with_timestamps",
          text: "Thanks, everyone.",
          words: [{ text: "Thanks,", start: 0.01, end: 0.1, type: "word" }],
        }),
      );
    }
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

const liveGrant: RecordingLiveSession = {
  providerId: "elevenlabs",
  model: "scribe_v2_realtime",
  protocol: "elevenlabs.scribe_realtime",
  url: "wss://live.example/?token=t",
  audio: { encoding: "pcm_s16le", sampleRate: 16_000 },
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

describe("native recorder", () => {
  test("records ADTS chunks, uploads them and finalizes, with interruptions as pauses", async () => {
    const { store } = await storeIn();
    const fake = fakeNative((id) => store.directory(id));
    const server = fakeServer();
    const snapshots: RecorderSnapshot[] = [];
    const recorder = createNativeRecorder({
      client: server.client,
      workspaceId: WORKSPACE,
      title: "Site walk",
      native: fake.native,
      store,
      fs: nodeFs,
      randomUUID: () => RECORDING,
      requestPermission: async () => true,
      notification: { title: "Recording audio", text: "Tap to return." },
      fetch: server.fetch,
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    await recorder.start();
    expect(recorder.snapshot.state).toBe("recording");
    expect(recorder.snapshot.tracks).toEqual([
      { trackNumber: 0, source: "microphone", label: "iPhone Microphone" },
    ]);
    expect(fake.state.started).toMatchObject({
      recordingId: RECORDING,
      directory: store.directory(RECORDING),
      chunkMilliseconds: 5_000,
    });
    await fake.writeChunk();
    fake.emitState({ recordingId: RECORDING, state: "interrupted" });
    expect(recorder.snapshot).toMatchObject({ state: "paused", pauseReason: "interruption" });
    fake.emitState({ recordingId: RECORDING, state: "recording" });
    expect(recorder.snapshot).toMatchObject({ state: "recording", pauseReason: null });
    recorder.pause();
    expect(recorder.snapshot).toMatchObject({ state: "paused", pauseReason: "person" });
    // A call ending does not resume what the person paused.
    fake.emitState({ recordingId: RECORDING, state: "recording" });
    expect(recorder.snapshot.state).toBe("paused");
    recorder.resume();
    await new Promise((done) => setTimeout(done, 0));
    expect(recorder.snapshot.state).toBe("recording");
    expect(recorder.levels()).toEqual({ 0: 0.5 });

    const status = await recorder.stop();
    expect(status?.finalized).toBe(true);
    expect(recorder.snapshot.state).toBe("stopped");
    expect(server.state.created).toMatchObject({
      title: "Site walk",
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/aac" }],
    });
    expect(server.state.finalized?.tracks).toEqual([{ trackNumber: 0, chunkCount: 2 }]);
    expect([...server.state.uploaded].sort()).toEqual([0, 1]);
    expect(server.stored.size).toBe(2);
    // Uploaded and finalized: nothing is left on the device.
    expect(await store.listRecordings()).toEqual([]);
    expect(snapshots.some((snapshot) => snapshot.state === "starting")).toBe(true);
  });

  test("a chunk file the upload pass sees before capture reads it is still counted", async () => {
    const { store } = await storeIn();
    const fake = fakeNative((id) => store.directory(id));
    const server = fakeServer();
    const recorder = createNativeRecorder({
      client: server.client,
      workspaceId: WORKSPACE,
      native: fake.native,
      store,
      // Capture reads each chunk a little late, as on a busy phone.
      fs: {
        ...nodeFs,
        async readBytes(path) {
          await new Promise((done) => setTimeout(done, 5));
          return await nodeFs.readBytes(path);
        },
      },
      randomUUID: () => RECORDING,
      requestPermission: async () => true,
      notification: { title: "t", text: "t" },
      fetch: server.fetch,
    });
    await recorder.start();
    await fake.writeChunk();
    await fake.writeChunk();

    const status = await recorder.stop();
    expect(recorder.snapshot.error).toBeNull();
    expect(status?.finalized).toBe(true);
    expect(server.state.finalized?.tracks).toEqual([{ trackNumber: 0, chunkCount: 3 }]);
    expect([...server.state.uploaded].sort()).toEqual([0, 1, 2]);
    expect(await store.listRecordings()).toEqual([]);
  });

  test("a declined microphone fails without creating anything", async () => {
    const { store } = await storeIn();
    const fake = fakeNative((id) => store.directory(id));
    const server = fakeServer();
    const recorder = createNativeRecorder({
      client: server.client,
      workspaceId: WORKSPACE,
      native: fake.native,
      store,
      fs: nodeFs,
      randomUUID: () => RECORDING,
      requestPermission: async () => false,
      notification: { title: "t", text: "t" },
      fetch: server.fetch,
    });
    await recorder.start();
    expect(recorder.snapshot.error?.code).toBe("microphone_denied");
    expect(fake.state.started).toBeNull();
    expect(await store.listRecordings()).toEqual([]);
  });

  test("discard stops capture and removes the local and server copies", async () => {
    const { store } = await storeIn();
    const fake = fakeNative((id) => store.directory(id));
    const server = fakeServer();
    const recorder = createNativeRecorder({
      client: server.client,
      workspaceId: WORKSPACE,
      native: fake.native,
      store,
      fs: nodeFs,
      randomUUID: () => RECORDING,
      requestPermission: async () => true,
      notification: { title: "t", text: "t" },
      fetch: server.fetch,
    });
    await recorder.start();
    await fake.writeChunk();
    await recorder.discard();
    expect(fake.state.active).toBeNull();
    expect(recorder.snapshot.state).toBe("idle");
    expect(await store.listRecordings()).toEqual([]);
  });

  test("streams the microphone to the live transcript while recording, not while paused", async () => {
    FakeLiveSocket.opened = [];
    const { store } = await storeIn();
    const fake = fakeNative((id) => store.directory(id));
    const server = fakeServer();
    const saved: AppendRecordingLiveSegmentsRequest[] = [];
    const recorder = createNativeRecorder({
      client: {
        ...server.client,
        createRecordingLiveSession: async () => liveGrant,
        appendRecordingLiveSegments: async (_workspace, _recording, request) => {
          saved.push(request);
          return { saved: request.segments.length, ended: false };
        },
      },
      workspaceId: WORKSPACE,
      native: fake.native,
      store,
      fs: nodeFs,
      randomUUID: () => RECORDING,
      requestPermission: async () => true,
      notification: { title: "t", text: "t" },
      fetch: server.fetch,
      liveTranscript: true,
      liveWebSocket: FakeLiveSocket,
    });
    await recorder.start();
    expect(fake.state.livePcm).toBe(true);
    expect(recorder.snapshot.live?.[0]).toMatchObject({ trackNumber: 0, state: "connecting" });
    fake.emitPcm(0);
    await new Promise((done) => setTimeout(done, 0));
    const socket = FakeLiveSocket.opened[0]!;
    socket.open();
    expect(recorder.snapshot.live?.[0]?.state).toBe("live");
    expect(socket.sent).toHaveLength(1);
    expect(atob(socket.sent[0]!.audio_base_64 as string).length).toBe(3_200);
    socket.receive({ message_type: "partial_transcript", text: "Good morn" });
    expect(recorder.snapshot.live?.[0]?.partial).toBe("Good morn");

    recorder.pause();
    fake.emitPcm(100);
    expect(socket.sent).toHaveLength(1);
    recorder.resume();
    await new Promise((done) => setTimeout(done, 0));
    fake.emitPcm(100);
    expect(socket.sent).toHaveLength(2);

    await recorder.stop();
    expect(fake.state.livePcm).toBe(false);
    expect(fake.pcmListeners()).toBe(0);
    expect(socket.sent.at(-1)).toMatchObject({ commit: true });
    expect(recorder.snapshot.state).toBe("stopped");
    expect(recorder.snapshot.live?.[0]?.state).toBe("closed");
    expect(saved.flatMap((request) => request.segments.map((segment) => segment.text))).toEqual([
      "Thanks, everyone.",
    ]);
  });

  test("without the live calls or a native tap, recording goes on with no live transcript", async () => {
    const { store } = await storeIn();
    const fake = fakeNative((id) => store.directory(id));
    const server = fakeServer();
    const recorder = createNativeRecorder({
      client: server.client,
      workspaceId: WORKSPACE,
      native: fake.native,
      store,
      fs: nodeFs,
      randomUUID: () => RECORDING,
      requestPermission: async () => true,
      notification: { title: "t", text: "t" },
      fetch: server.fetch,
      liveTranscript: true,
    });
    await recorder.start();
    expect(recorder.snapshot.state).toBe("recording");
    expect(fake.state.livePcm).toBe(false);
    expect(recorder.snapshot.live ?? null).toBeNull();
    await recorder.discard();
  });
});
