import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createBrowserRecorder,
  type RecorderSnapshot,
  type SystemAudioSource,
  type RecordingChunk,
  type RecordingTransport,
  type RecordingUploader,
  type RecordingUploadStatus,
} from "../src/recordings";

// A microphone track that can go away the way an unplugged one does.
class FakeTrack extends EventTarget {
  stopped = false;
  constructor(readonly label: string) {
    super();
  }
  stop() {
    this.stopped = true;
  }
  /** The device went away: the browser ends the track (stop() itself never fires this). */
  unplug() {
    this.dispatchEvent(new Event("ended"));
  }
}

function fakeStream(track: FakeTrack): MediaStream {
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string) {
    return type.startsWith("audio/webm");
  }
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  constructor(
    readonly stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    super();
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  requestData() {}
  /** Cut a chunk, as the timeslice does. */
  slice(bytes = 4) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
  }
  stop() {
    this.state = "inactive";
    // A real recorder hands over its last chunk, then reports stopped, a little later.
    setTimeout(() => {
      this.slice();
      this.dispatchEvent(new Event("stop"));
    }, 5);
  }
}

/** An uploader that keeps what the recorder hands it. */
function fakeUploader() {
  const chunks: RecordingChunk[] = [];
  let finished = false;
  const status = (recordingId: string): RecordingUploadStatus =>
    ({ recordingId, failed: null }) as unknown as RecordingUploadStatus;
  const uploader = {
    subscribe: () => () => undefined,
    begin: async () => undefined,
    addChunk: async (chunk: RecordingChunk) => {
      if (finished) throw new Error("a chunk arrived after the upload finished");
      chunks.push(chunk);
    },
    finish: async (recordingId: string) => {
      finished = true;
      return status(recordingId);
    },
    discard: async () => undefined,
  } as unknown as RecordingUploader;
  return { uploader, chunks };
}

let opened: FakeTrack[] = [];
/** What the next getUserMedia calls do: open a microphone, find none, or be refused. */
let microphone: Array<"ok" | "none" | "denied"> = [];
const devices = new EventTarget();

beforeEach(() => {
  opened = [];
  microphone = [];
  FakeMediaRecorder.instances = [];
  Object.assign(devices, {
    getUserMedia: async () => {
      const next = microphone.shift() ?? "ok";
      if (next === "denied") throw new DOMException("Permission denied", "NotAllowedError");
      if (next === "none") throw new DOMException("Requested device not found", "NotFoundError");
      const track = new FakeTrack(`Microphone ${opened.length + 1}`);
      opened.push(track);
      return fakeStream(track);
    },
  });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: devices });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: FakeMediaRecorder,
  });
});

afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

const tick = (milliseconds = 20) => new Promise((done) => setTimeout(done, milliseconds));

async function recordMeeting(options: { systemAudio?: SystemAudioSource } = {}) {
  const { uploader, chunks } = fakeUploader();
  const snapshots: RecorderSnapshot[] = [];
  const recorder = createBrowserRecorder({
    client: {} as RecordingTransport,
    workspaceId: "workspace",
    uploader,
    keepAwake: false,
    ...(options.systemAudio ? { systemAudio: true, systemAudioSource: options.systemAudio } : {}),
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  await recorder.start();
  expect(recorder.snapshot.state).toBe("recording");
  return { recorder, chunks, snapshots };
}

describe("a microphone that goes away mid-recording", () => {
  test("is opened again and records on in the same track, as a new run", async () => {
    const { recorder, chunks, snapshots } = await recordMeeting();
    const first = FakeMediaRecorder.instances[0]!;
    first.slice();
    await tick();

    microphone.push("none");
    opened[0]!.unplug();
    await tick();
    expect(recorder.snapshot.tracks[0]?.lost).toBe("reconnecting");
    expect(snapshots.some((snapshot) => snapshot.tracks[0]?.lost === "reconnecting")).toBe(true);
    expect(recorder.snapshot.state).toBe("recording");

    // A microphone is plugged in again.
    devices.dispatchEvent(new Event("devicechange"));
    await tick();
    expect(recorder.snapshot.tracks[0]?.lost).toBeUndefined();
    expect(recorder.snapshot.tracks[0]?.label).toBe("Microphone 2");
    expect(opened[0]!.stopped).toBe(true);
    const second = FakeMediaRecorder.instances[1]!;
    expect(second.state).toBe("recording");
    expect(second.mimeType).toBe(first.mimeType);
    second.slice();
    await tick();

    await recorder.stop();
    // Numbering carries on through the gap, every chunk on track 0.
    expect(chunks.map((chunk) => [chunk.trackNumber, chunk.chunkNumber])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
    // The new run starts where the microphone came back, not at the old run's end.
    const resumedAt = chunks[2]!.startMilliseconds;
    expect(resumedAt).toBeGreaterThanOrEqual(
      chunks[1]!.startMilliseconds + chunks[1]!.durationMilliseconds,
    );
  });

  test("stays stopped when the browser refuses it, and the meeting still finishes", async () => {
    const { recorder, chunks } = await recordMeeting();
    microphone.push("denied");
    opened[0]!.unplug();
    await tick();
    devices.dispatchEvent(new Event("devicechange"));
    await tick();
    expect(recorder.snapshot.tracks[0]?.lost).toBe("stopped");
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    const status = await recorder.stop();
    expect(status).not.toBeNull();
    expect(recorder.snapshot.state).toBe("stopped");
    expect(chunks).toHaveLength(1);
  });

  test("stopping while it is away keeps its last chunk and opens nothing more", async () => {
    const { recorder, chunks } = await recordMeeting();
    microphone.push("none", "none", "none");
    opened[0]!.unplug();
    // Stop before the dropped recorder has handed over its last chunk.
    await recorder.stop();
    expect(chunks).toHaveLength(1);
    const tries = opened.length;
    devices.dispatchEvent(new Event("devicechange"));
    await tick(50);
    expect(opened.length).toBe(tries);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  test("comes back paused when the recording is paused", async () => {
    const { recorder } = await recordMeeting();
    microphone.push("none");
    opened[0]!.unplug();
    await tick();
    recorder.pause();
    devices.dispatchEvent(new Event("devicechange"));
    await tick();
    expect(FakeMediaRecorder.instances[1]?.state).toBe("paused");
    recorder.resume();
    expect(FakeMediaRecorder.instances[1]?.state).toBe("recording");
    await recorder.stop();
  });

  test("refused, it is opened again when the person asks", async () => {
    const { recorder, chunks } = await recordMeeting();
    microphone.push("denied");
    opened[0]!.unplug();
    await tick();
    expect(recorder.snapshot.tracks[0]?.lost).toBe("stopped");
    await recorder.reconnect!(0);
    expect(recorder.snapshot.tracks[0]?.lost).toBeUndefined();
    FakeMediaRecorder.instances[1]!.slice();
    await recorder.stop();
    expect(chunks.map((chunk) => chunk.chunkNumber)).toEqual([0, 1, 2]);
  });
});

describe("shared audio that ends mid-recording", () => {
  test("stays stopped until the person shares again, then records on in its track", async () => {
    const shares: Array<{ track: FakeTrack; released: boolean }> = [];
    const systemAudio: SystemAudioSource = {
      kind: "display",
      async open() {
        const share = { track: new FakeTrack(`Tab ${shares.length + 1}`), released: false };
        shares.push(share);
        return {
          stream: fakeStream(share.track),
          label: share.track.label,
          stop: () => {
            share.released = true;
          },
        };
      },
    };
    const { recorder, chunks } = await recordMeeting({ systemAudio });
    expect(recorder.snapshot.tracks.map((track) => track.source)).toEqual(["microphone", "system"]);
    shares[0]!.track.unplug();
    await tick();
    // It never asks by itself: sharing needs the person.
    expect(recorder.snapshot.tracks[1]?.lost).toBe("stopped");
    expect(shares).toHaveLength(1);
    expect(recorder.snapshot.tracks[0]?.lost).toBeUndefined();

    await recorder.reconnect!(1);
    expect(shares).toHaveLength(2);
    expect(shares[0]!.released).toBe(true);
    expect(recorder.snapshot.tracks[1]).toMatchObject({ source: "system", label: "Tab 2" });
    expect(recorder.snapshot.tracks[1]?.lost).toBeUndefined();
    FakeMediaRecorder.instances[2]!.slice();
    await recorder.stop();
    expect(shares[1]!.released).toBe(true);
    const tabChunks = chunks.filter((chunk) => chunk.trackNumber === 1);
    expect(tabChunks.map((chunk) => chunk.chunkNumber)).toEqual([0, 1, 2]);
  });
});
