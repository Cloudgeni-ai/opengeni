import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createBrowserRecorder,
  type Recorder,
  type RecordingChunk,
  type RecordingUploader,
} from "../src/recordings";

// A microphone that goes away mid-recording (unplugged, a headset switching
// profile when a call starts) used to stop its recorder for good while the
// page went on showing a running clock: a two-hour meeting kept 15 seconds.

class FakeTrack extends EventTarget {
  readyState: "live" | "ended" = "live";
  constructor(readonly label: string) {
    super();
  }
  stop() {
    // Like a browser: stopping a track yourself fires no "ended".
    this.readyState = "ended";
  }
  /** The device went away. */
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeStream {
  readonly track: FakeTrack;
  constructor(label: string) {
    this.track = new FakeTrack(label);
  }
  getTracks() {
    return [this.track];
  }
  getAudioTracks() {
    return [this.track];
  }
}

class FakeMediaRecorder extends EventTarget {
  static created: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string) {
    return type === "audio/webm;codecs=opus";
  }
  state: "inactive" | "recording" | "paused" = "inactive";
  readonly mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  constructor(
    readonly stream: FakeStream,
    options: { mimeType?: string } = {},
  ) {
    super();
    this.mimeType = options.mimeType ?? "";
    FakeMediaRecorder.created.push(this);
  }
  start() {
    this.state = "recording";
  }
  pause() {
    if (this.state === "recording") this.state = "paused";
  }
  resume() {
    if (this.state === "paused") this.state = "recording";
  }
  requestData() {}
  /** Hand over a chunk of audio, as a timeslice does. */
  emit(size = 100) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(size).fill(1)]) });
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    // The last chunk, then "stop", after the current task like a browser.
    queueMicrotask(() => {
      this.emit(10);
      this.dispatchEvent(new Event("stop"));
    });
  }
}

class FakeMediaDevices extends EventTarget {
  /** What the next getUserMedia calls do, in order; an empty queue opens a microphone. */
  next: Array<"open" | "fail"> = [];
  opened: FakeStream[] = [];
  calls = 0;
  async getUserMedia(_constraints: unknown) {
    this.calls += 1;
    if (this.next.shift() === "fail") {
      throw Object.assign(new Error("Requested device not found"), { name: "NotFoundError" });
    }
    const stream = new FakeStream(`Microphone ${this.opened.length + 1}`);
    this.opened.push(stream);
    return stream;
  }
}

function fakeUploader() {
  const chunks: RecordingChunk[] = [];
  const finished: string[] = [];
  const uploader = {
    begin: async () => undefined,
    addChunk: async (chunk: RecordingChunk) => {
      chunks.push(chunk);
    },
    finish: async (recordingId: string) => {
      finished.push(recordingId);
      return { recordingId, discarded: false, failed: null } as never;
    },
    subscribe: () => () => undefined,
    discard: async () => undefined,
    rename: async () => undefined,
  } as unknown as RecordingUploader;
  return { uploader, chunks, finished };
}

async function waitFor(condition: () => boolean, timeout = 2_000) {
  const until = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((done) => setTimeout(done, 5));
  }
}

const scope = globalThis as Record<string, unknown>;
let devices: FakeMediaDevices;
let savedMediaRecorder: unknown;
let savedMediaDevices: PropertyDescriptor | undefined;
const recorders: Recorder[] = [];

beforeEach(() => {
  FakeMediaRecorder.created = [];
  devices = new FakeMediaDevices();
  savedMediaRecorder = scope.MediaRecorder;
  scope.MediaRecorder = FakeMediaRecorder;
  savedMediaDevices = Object.getOwnPropertyDescriptor(globalThis.navigator, "mediaDevices");
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value: devices,
    configurable: true,
  });
});

afterEach(async () => {
  for (const recorder of recorders.splice(0)) {
    if (recorder.snapshot.state === "recording" || recorder.snapshot.state === "paused") {
      await recorder.stop();
    }
  }
  scope.MediaRecorder = savedMediaRecorder;
  if (savedMediaDevices)
    Object.defineProperty(globalThis.navigator, "mediaDevices", savedMediaDevices);
  else delete (globalThis.navigator as unknown as Record<string, unknown>).mediaDevices;
});

async function startRecorder(timesliceMilliseconds = 5_000) {
  const upload = fakeUploader();
  const recorder = createBrowserRecorder({
    client: {} as never,
    workspaceId: "workspace",
    uploader: upload.uploader,
    keepAwake: false,
    timesliceMilliseconds,
  });
  recorders.push(recorder);
  await recorder.start();
  expect(recorder.snapshot.state).toBe("recording");
  return { recorder, ...upload };
}

const latestRecorder = () => FakeMediaRecorder.created.at(-1)!;

describe("browser recorder when the microphone goes away", () => {
  test("opens the microphone again and goes on recording the same track", async () => {
    const { recorder, chunks, finished } = await startRecorder();
    const first = latestRecorder();
    first.emit();
    devices.opened[0]!.track.end();

    await waitFor(() => FakeMediaRecorder.created.length === 2);
    const second = latestRecorder();
    expect(second.state).toBe("recording");
    expect(second.stream).toBe(devices.opened[1]!);
    expect(second.mimeType).toBe("audio/webm;codecs=opus");
    // Another microphone opened at once: the recording never paused.
    expect(recorder.snapshot.state).toBe("recording");
    second.emit();

    await recorder.stop();
    // The old session's last chunk comes before the new session's first.
    expect(
      chunks.map((chunk) => [chunk.trackNumber, chunk.chunkNumber, chunk.bytes.length]),
    ).toEqual([
      [0, 0, 100],
      [0, 1, 10],
      [0, 2, 100],
      [0, 3, 10],
    ]);
    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index]!.startMilliseconds).toBeGreaterThanOrEqual(
        chunks[index - 1]!.startMilliseconds,
      );
    }
    expect(finished).toHaveLength(1);
    // Stop closes the microphone in use, not just the first one.
    expect(devices.opened[1]!.track.readyState).toBe("ended");
  });

  test("pauses the clock until a microphone is back, then records again", async () => {
    const { recorder, chunks } = await startRecorder();
    latestRecorder().emit();
    devices.next = ["fail"];
    devices.opened[0]!.track.end();

    await waitFor(() => recorder.snapshot.state === "paused");
    expect(recorder.snapshot.pauseReason).toBe("interruption");
    await waitFor(() => devices.calls === 2);
    const frozen = recorder.snapshot.elapsedMilliseconds;
    await new Promise((done) => setTimeout(done, 40));
    expect(recorder.snapshot.elapsedMilliseconds).toBe(frozen);

    // A headset is plugged in.
    devices.dispatchEvent(new Event("devicechange"));
    await waitFor(() => recorder.snapshot.state === "recording");
    expect(recorder.snapshot.pauseReason).toBeNull();
    expect(latestRecorder().stream).toBe(devices.opened[1]!);
    latestRecorder().emit();
    await recorder.stop();

    const resumedAt = chunks.find((chunk) => chunk.chunkNumber === 2)!.startMilliseconds;
    // The time without a microphone is not counted as recorded time.
    expect(resumedAt).toBeLessThan(frozen + 20);
  });

  test("a person's pause while the microphone is gone holds after it is back", async () => {
    const { recorder } = await startRecorder();
    devices.next = ["fail"];
    devices.opened[0]!.track.end();
    await waitFor(() => recorder.snapshot.pauseReason === "interruption");
    await waitFor(() => devices.calls === 2);

    recorder.pause();
    expect(recorder.snapshot).toMatchObject({ state: "paused", pauseReason: "person" });
    devices.dispatchEvent(new Event("devicechange"));
    await waitFor(() => FakeMediaRecorder.created.length === 2);
    await waitFor(() => latestRecorder().state === "paused");
    expect(recorder.snapshot).toMatchObject({ state: "paused", pauseReason: "person" });

    recorder.resume();
    expect(recorder.snapshot.state).toBe("recording");
    expect(latestRecorder().state).toBe("recording");
  });

  test("Resume while the microphone is gone tries it again instead of pretending to record", async () => {
    const { recorder } = await startRecorder();
    devices.next = ["fail", "fail"];
    devices.opened[0]!.track.end();
    await waitFor(() => devices.calls === 2);
    expect(recorder.snapshot.pauseReason).toBe("interruption");

    recorder.resume();
    await waitFor(() => devices.calls === 3);
    expect(recorder.snapshot).toMatchObject({ state: "paused", pauseReason: "interruption" });

    recorder.resume();
    await waitFor(() => recorder.snapshot.state === "recording");
  });

  test("a microphone recorder that hands over nothing is opened again", async () => {
    // 10 ms timeslices: silent for six of them counts as stalled.
    const { recorder } = await startRecorder(10);
    await waitFor(() => FakeMediaRecorder.created.length === 2, 3_000);
    expect(FakeMediaRecorder.created[0]!.state).toBe("inactive");
    expect(latestRecorder().state).toBe("recording");
    expect(recorder.snapshot.state).toBe("recording");
  });

  test("Stop while the microphone is gone finishes the recording", async () => {
    const { recorder, finished } = await startRecorder();
    latestRecorder().emit();
    devices.next = ["fail"];
    devices.opened[0]!.track.end();
    await waitFor(() => recorder.snapshot.pauseReason === "interruption");

    const status = await recorder.stop();
    expect(status).toMatchObject({ discarded: false, failed: null });
    expect(recorder.snapshot.state).toBe("stopped");
    expect(finished).toHaveLength(1);
    const calls = devices.calls;
    devices.dispatchEvent(new Event("devicechange"));
    await new Promise((done) => setTimeout(done, 20));
    // Nothing is reopened after the recording ended.
    expect(devices.calls).toBe(calls);
  });
});
