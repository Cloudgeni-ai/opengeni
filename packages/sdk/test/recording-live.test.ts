import { describe, expect, test } from "bun:test";
import type { AppendRecordingLiveSegmentsRequest, RecordingLiveSession } from "@opengeni/contracts";
import { OpenGeniApiError } from "../src/errors";
import { createLiveTranscriber, resamplePcm16, type LiveWebSocket } from "../src/recording-live";

class FakeSocket implements LiveWebSocket {
  static opened: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
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
    const last = this.sent.at(-1)!;
    // The provider answers a final commit with what it heard last.
    if (last.commit === true) {
      queueMicrotask(() =>
        this.receive({
          message_type: "committed_transcript_with_timestamps",
          text: "See you.",
          words: [{ text: "See", start: 0.5, end: 0.7, type: "word" }],
        }),
      );
    }
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

const grant: RecordingLiveSession = {
  providerId: "elevenlabs",
  model: "scribe_v2_realtime",
  protocol: "elevenlabs.scribe_realtime",
  url: "wss://live.example/?token=t",
  audio: { encoding: "pcm_s16le", sampleRate: 16_000 },
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

function client(options: { failFirstGrant?: Error } = {}) {
  const saved: AppendRecordingLiveSegmentsRequest[] = [];
  let grants = 0;
  return {
    saved,
    grants: () => grants,
    createRecordingLiveSession: async () => {
      grants += 1;
      if (grants === 1 && options.failFirstGrant) throw options.failFirstGrant;
      return grant;
    },
    appendRecordingLiveSegments: async (
      _workspace: string,
      _recording: string,
      request: AppendRecordingLiveSegmentsRequest,
    ) => {
      saved.push(request);
      return { saved: request.segments.length, ended: false };
    },
  };
}

const tenth = (value = 1_000) => new Int16Array(1_600).fill(value);
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("live transcriber", () => {
  test("streams tenths of a second, shows partial text and saves timed segments", async () => {
    FakeSocket.opened = [];
    const api = client();
    const live = createLiveTranscriber({
      client: api,
      workspaceId: "w",
      recordingId: "r",
      trackNumber: 1,
      WebSocket: FakeSocket,
    });
    live.push(tenth(), 16_000, 2_000);
    await settle();
    const socket = FakeSocket.opened[0]!;
    expect(socket.url).toBe(grant.url);
    socket.open();
    expect(live.snapshot.state).toBe("live");
    expect(socket.sent[0]).toMatchObject({
      message_type: "input_audio_chunk",
      commit: false,
      sample_rate: 16_000,
    });
    expect(atob(socket.sent[0]!.audio_base_64 as string).length).toBe(3_200);
    live.push(tenth(), 16_000, 2_100);
    expect(socket.sent).toHaveLength(2);
    socket.receive({ message_type: "partial_transcript", text: "Good morn" });
    expect(live.snapshot.partial).toBe("Good morn");
    socket.receive({ message_type: "committed_transcript", text: "Good morning." });
    socket.receive({
      message_type: "committed_transcript_with_timestamps",
      text: "Good morning.",
      words: [
        { text: "Good", start: 0.02, end: 0.08, type: "word" },
        { text: " ", start: 0.08, end: 0.09, type: "spacing" },
        { text: "morning.", start: 0.09, end: 0.19, type: "word" },
      ],
    });
    // Times are the recording's: the session's audio began 2 s in.
    expect(live.snapshot.segments).toEqual([
      {
        trackNumber: 1,
        segmentNumber: 0,
        startMilliseconds: 2_020,
        endMilliseconds: 2_190,
        text: "Good morning.",
      },
    ]);
    expect(live.snapshot.partial).toBe("");
    await live.close();
    expect(socket.sent.at(-1)).toMatchObject({ audio_base_64: "", commit: true });
    expect(live.snapshot.segments.map((segment) => segment.text)).toEqual([
      "Good morning.",
      "See you.",
    ]);
    expect(live.snapshot.state).toBe("closed");
    // The plain commit was replaced by its timed copy, so nothing is doubled.
    expect(api.saved.flatMap((request) => request.segments.map((segment) => segment.text))).toEqual(
      ["Good morning.", "See you."],
    );
    expect(api.saved.at(-1)!.streamedMilliseconds).toBe(200);
  });

  test("a missing provider key makes it unavailable without retrying", async () => {
    FakeSocket.opened = [];
    const api = client({
      failFirstGrant: new OpenGeniApiError(
        409,
        JSON.stringify({
          error: {
            code: "conflict",
            message:
              "Add an ElevenLabs API key to this workspace's models to see a live transcript.",
            details: { code: "credential_unavailable" },
          },
        }),
      ),
    });
    const live = createLiveTranscriber({
      client: api,
      workspaceId: "w",
      recordingId: "r",
      trackNumber: 0,
      WebSocket: FakeSocket,
    });
    live.push(tenth(), 16_000, 0);
    await settle();
    live.push(tenth(), 16_000, 100);
    await settle();
    expect(live.snapshot.state).toBe("unavailable");
    expect(live.snapshot.error?.code).toBe("credential_unavailable");
    expect(api.grants()).toBe(1);
    expect(FakeSocket.opened).toHaveLength(0);
  });

  test("a dropped connection holds audio and reconnects with a new grant", async () => {
    FakeSocket.opened = [];
    const api = client();
    const live = createLiveTranscriber({
      client: api,
      workspaceId: "w",
      recordingId: "r",
      trackNumber: 0,
      WebSocket: FakeSocket,
    });
    live.push(tenth(), 16_000, 0);
    await settle();
    FakeSocket.opened[0]!.open();
    FakeSocket.opened[0]!.close();
    expect(live.snapshot.state).toBe("reconnecting");
    // Held while waiting out the backoff.
    live.push(tenth(), 16_000, 100);
    await settle();
    expect(FakeSocket.opened).toHaveLength(1);
    await new Promise((done) => setTimeout(done, 1_050));
    live.push(tenth(), 16_000, 200);
    await settle();
    const second = FakeSocket.opened[1]!;
    second.open();
    expect(api.grants()).toBe(2);
    expect(second.sent).toHaveLength(2);
    second.receive({
      message_type: "committed_transcript_with_timestamps",
      text: "Back.",
      words: [{ text: "Back.", start: 0.05, end: 0.15, type: "word" }],
    });
    // The new session's clock starts where its first held audio was recorded.
    expect(live.snapshot.segments[0]).toMatchObject({
      startMilliseconds: 150,
      endMilliseconds: 250,
    });
    live.abort();
    expect(live.snapshot.state).toBe("closed");
  });

  test("a fatal provider error stops the preview", async () => {
    FakeSocket.opened = [];
    const live = createLiveTranscriber({
      client: client(),
      workspaceId: "w",
      recordingId: "r",
      trackNumber: 0,
      WebSocket: FakeSocket,
    });
    live.push(tenth(), 16_000, 0);
    await settle();
    FakeSocket.opened[0]!.open();
    FakeSocket.opened[0]!.receive({ message_type: "quota_exceeded", error: "No credit" });
    expect(live.snapshot).toMatchObject({
      state: "unavailable",
      error: { code: "quota_exceeded" },
    });
  });

  test("sessions refused right after they start back off longer each time", async () => {
    FakeSocket.opened = [];
    const api = client();
    const live = createLiveTranscriber({
      client: api,
      workspaceId: "w",
      recordingId: "r",
      trackNumber: 0,
      WebSocket: FakeSocket,
    });
    // What a provider at its limit of parallel sessions does.
    const refuse = (socket: FakeSocket) => {
      socket.open();
      socket.receive({ message_type: "rate_limited", error: "Too many concurrent requests" });
      socket.close();
    };
    let at = 0;
    const tick = async (milliseconds: number) => {
      await new Promise((done) => setTimeout(done, milliseconds));
      at += 100;
      live.push(tenth(), 16_000, at);
      await settle();
    };
    live.push(tenth(), 16_000, 0);
    await settle();
    refuse(FakeSocket.opened[0]!);
    expect(live.snapshot).toMatchObject({ state: "reconnecting", error: { code: "rate_limited" } });
    await tick(1_050);
    expect(FakeSocket.opened).toHaveLength(2);
    refuse(FakeSocket.opened[1]!);
    // The second wait is twice as long, although the session had started.
    await tick(1_050);
    expect(FakeSocket.opened).toHaveLength(2);
    await tick(1_000);
    expect(FakeSocket.opened).toHaveLength(3);
    // Text proves a session works, so a later drop retries quickly again.
    const third = FakeSocket.opened[2]!;
    third.open();
    third.receive({ message_type: "partial_transcript", text: "Hello" });
    third.close();
    await tick(1_050);
    expect(FakeSocket.opened).toHaveLength(4);
    live.abort();
  });
});

describe("resamplePcm16", () => {
  test("averages down and keeps exact tenths for common rates", () => {
    expect(resamplePcm16(new Int16Array(4_800).fill(300), 48_000, 16_000)).toHaveLength(1_600);
    expect(resamplePcm16(new Int16Array(4_410).fill(300), 44_100, 16_000)).toHaveLength(1_600);
    expect([...resamplePcm16(Int16Array.from([0, 3, 6, 9, 12, 15]), 48_000, 16_000)]).toEqual([
      3, 12,
    ]);
  });
});
