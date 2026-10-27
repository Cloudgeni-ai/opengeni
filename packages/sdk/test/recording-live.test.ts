import { describe, expect, test } from "bun:test";
import type { AppendRecordingLiveSegmentsRequest, RecordingLiveSession } from "@opengeni/contracts";
import { OpenGeniApiError } from "../src/errors";
import {
  createLiveTranscriber,
  resamplePcm16,
  type LiveFetch,
  type LiveMediaTrack,
  type LiveWebSocket,
} from "../src/recording-live";

class FakeSocket implements LiveWebSocket {
  static opened: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: { headers?: Record<string, string> },
  ) {
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
    if (last.type === "input_audio_buffer.commit") queueMicrotask(() => this.receive(commitEmpty));
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

const openAiGrant: RecordingLiveSession = {
  providerId: "azure-openai",
  model: "gpt-4o-transcribe",
  protocol: "openai.realtime",
  url: "wss://ai.example/openai/v1/realtime?intent=transcription",
  token: "ek_test",
  webrtcUrl: "https://ai.example/openai/v1/realtime/calls",
  audio: { encoding: "pcm_s16le", sampleRate: 24_000 },
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

/** What OpenAI Realtime answers a final commit with when the last words were already sent. */
const commitEmpty = {
  type: "error",
  error: {
    type: "invalid_request_error",
    code: "input_audio_buffer_commit_empty",
    message: "Buffer too small.",
  },
};

class FakeTrack implements LiveMediaTrack {
  enabled = true;
  stopped = false;
  copies: FakeTrack[] = [];
  clone() {
    const copy = new FakeTrack();
    this.copies.push(copy);
    return copy;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeChannel {
  readyState = "connecting";
  sent: Array<Record<string, unknown>> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  constructor(readonly label: string) {}
  open() {
    this.readyState = "open";
    this.onopen?.({});
  }
  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  send(data: string) {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === "input_audio_buffer.commit") {
      queueMicrotask(() => this.receive(commitEmpty));
    }
  }
  close() {
    this.readyState = "closed";
  }
}

class FakePeer {
  static created: FakePeer[] = [];
  connectionState = "new";
  tracks: FakeTrack[] = [];
  channel: FakeChannel | null = null;
  remote: { type: string; sdp: string } | null = null;
  closed = false;
  onconnectionstatechange: ((event: unknown) => void) | null = null;
  constructor() {
    FakePeer.created.push(this);
  }
  addTrack(track: LiveMediaTrack) {
    this.tracks.push(track as FakeTrack);
  }
  createDataChannel(label: string) {
    this.channel = new FakeChannel(label);
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "offer-sdp" };
  }
  async setLocalDescription() {}
  async setRemoteDescription(description: { type: "answer"; sdp: string }) {
    this.remote = description;
  }
  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
}

function offers(status = 201) {
  const posted: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const post: LiveFetch = async (url, init) => {
    posted.push({ url, headers: init.headers, body: init.body });
    return { ok: status < 300, status, text: async () => "answer-sdp" };
  };
  return { posted, post };
}

function client(options: { failFirstGrant?: Error; grant?: RecordingLiveSession } = {}) {
  const saved: AppendRecordingLiveSegmentsRequest[] = [];
  let grants = 0;
  return {
    saved,
    grants: () => grants,
    createRecordingLiveSession: async () => {
      grants += 1;
      if (grants === 1 && options.failFirstGrant) throw options.failFirstGrant;
      return options.grant ?? grant;
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

describe("live transcriber on OpenAI Realtime", () => {
  test("a phone streams PCM over a WebSocket signed in with a header", async () => {
    FakeSocket.opened = [];
    const api = client({ grant: openAiGrant });
    const live = createLiveTranscriber({
      client: api,
      workspaceId: "w",
      recordingId: "r",
      trackNumber: 0,
      WebSocket: FakeSocket,
      webSocketHeaders: true,
    });
    live.push(tenth(), 16_000, 2_000);
    await settle();
    const socket = FakeSocket.opened[0]!;
    expect(socket.url).toBe(openAiGrant.url);
    expect(socket.options).toEqual({ headers: { Authorization: "Bearer ek_test" } });
    socket.readyState = 1;
    socket.onopen?.({});
    expect(live.snapshot.state).toBe("live");
    // A tenth of a second at the session's 24 kHz.
    expect(socket.sent[0]!.type).toBe("input_audio_buffer.append");
    expect(atob(socket.sent[0]!.audio as string).length).toBe(4_800);
    socket.receive({ type: "input_audio_buffer.speech_started", item_id: "a", audio_start_ms: 20 });
    socket.receive({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "a",
      delta: "God ",
    });
    socket.receive({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "a",
      delta: "morgen",
    });
    expect(live.snapshot.partial).toBe("God morgen");
    socket.receive({ type: "input_audio_buffer.speech_stopped", item_id: "a", audio_end_ms: 190 });
    socket.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "a",
      transcript: "God morgen.",
    });
    expect(live.snapshot.segments).toEqual([
      {
        trackNumber: 0,
        segmentNumber: 0,
        startMilliseconds: 2_020,
        endMilliseconds: 2_190,
        text: "God morgen.",
      },
    ]);
    expect(live.snapshot.partial).toBe("");
    await live.close();
    expect(socket.sent.at(-1)).toEqual({ type: "input_audio_buffer.commit" });
    expect(live.snapshot.state).toBe("closed");
    expect(api.saved.at(-1)!.streamedMilliseconds).toBe(100);
  });

  test("a browser sends a copy of the track over WebRTC and times text by the recording", async () => {
    FakeSocket.opened = [];
    FakePeer.created = [];
    const api = client({ grant: openAiGrant });
    const { posted, post } = offers();
    const track = new FakeTrack();
    let now = 1_000;
    const live = createLiveTranscriber({
      client: api,
      workspaceId: "w",
      recordingId: "r",
      trackNumber: 1,
      WebSocket: FakeSocket,
      RTCPeerConnection: FakePeer,
      mediaTrack: track,
      fetch: post,
      now: () => now,
    });
    live.push(tenth(), 16_000, 5_000);
    await settle();
    await settle();
    const peer = FakePeer.created[0]!;
    expect(FakeSocket.opened).toHaveLength(0);
    expect(peer.tracks).toEqual([track.copies[0]!]);
    expect(peer.channel?.label).toBe("oai-events");
    expect(posted).toEqual([
      {
        url: openAiGrant.webrtcUrl!,
        headers: { Authorization: "Bearer ek_test", "Content-Type": "application/sdp" },
        body: "offer-sdp",
      },
    ]);
    expect(peer.remote).toEqual({ type: "answer", sdp: "answer-sdp" });
    now = 1_100;
    peer.channel!.open();
    expect(live.snapshot.state).toBe("live");
    // Pushed audio only keeps the clock: one tenth per tenth of a second.
    for (const at of [5_100, 5_200, 5_300]) {
      live.push(tenth(), 16_000, at);
      now += 100;
    }
    expect(peer.channel!.sent).toEqual([]);
    const channel = peer.channel!;
    channel.receive({
      type: "input_audio_buffer.speech_started",
      item_id: "a",
      audio_start_ms: 50,
    });
    channel.receive({ type: "input_audio_buffer.speech_stopped", item_id: "a", audio_end_ms: 180 });
    channel.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "a",
      transcript: "Hei.",
    });
    // 50 ms into the session's audio is 50 ms after the 5.2 s mark was pushed.
    expect(live.snapshot.segments[0]).toMatchObject({
      startMilliseconds: 5_250,
      endMilliseconds: 5_380,
      text: "Hei.",
    });
    live.setPaused(true);
    expect(track.copies[0]!.enabled).toBe(false);
    live.setPaused(false);
    expect(track.copies[0]!.enabled).toBe(true);
    await live.close();
    expect(channel.sent.at(-1)).toEqual({ type: "input_audio_buffer.commit" });
    expect(peer.closed).toBe(true);
    expect(track.copies[0]!.stopped).toBe(true);
    // The recording's own track is left alone.
    expect(track.stopped).toBe(false);
    expect(live.snapshot.state).toBe("closed");
    expect(api.saved.at(-1)!.streamedMilliseconds).toBe(300);
  });

  test("a refused WebRTC offer stops the preview without retrying", async () => {
    FakePeer.created = [];
    const api = client({ grant: openAiGrant });
    const track = new FakeTrack();
    const live = createLiveTranscriber({
      client: api,
      workspaceId: "w",
      recordingId: "r",
      trackNumber: 0,
      RTCPeerConnection: FakePeer,
      mediaTrack: track,
      fetch: offers(401).post,
    });
    live.push(tenth(), 16_000, 0);
    await settle();
    await settle();
    expect(live.snapshot).toMatchObject({ state: "unavailable", error: { code: "unavailable" } });
    expect(FakePeer.created[0]!.closed).toBe(true);
    expect(track.copies[0]!.stopped).toBe(true);
    live.push(tenth(), 16_000, 100);
    await settle();
    expect(api.grants()).toBe(1);
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
