import { describe, expect, test } from "bun:test";

import {
  OpenAIRealtimeTranscriptionProvider,
  type OpenAIDataChannelLike,
  type OpenAIMediaStreamLike,
  type OpenAIPeerConnectionLike,
} from "../src/transcription/openai-realtime";
import type { TranscriptionEvent } from "../src/transcription/types";

class FakeDataChannel implements OpenAIDataChannelLike {
  closed = false;
  private readonly messageListeners = new Set<(event: { data: unknown }) => void>();

  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void {
    if (type === "message") this.messageListeners.add(listener);
  }

  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void {
    if (type === "message") this.messageListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  message(value: unknown): void {
    const data = typeof value === "string" ? value : JSON.stringify(value);
    for (const listener of this.messageListeners) listener({ data });
  }
}

class FakePeerConnection implements OpenAIPeerConnectionLike {
  connectionState = "new";
  readonly channel = new FakeDataChannel();
  readonly tracks: unknown[] = [];
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  closed = false;
  private readonly stateListeners = new Set<() => void>();

  addTrack(track: unknown): void {
    this.tracks.push(track);
  }

  createDataChannel(label: string): OpenAIDataChannelLike {
    expect(label).toBe("oai-events");
    return this.channel;
  }

  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    return { type: "offer", sdp: "mock-offer-sdp" };
  }

  async setLocalDescription(description: unknown): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: unknown): Promise<void> {
    this.remoteDescription = description;
  }

  addEventListener(type: "connectionstatechange", listener: () => void): void {
    if (type === "connectionstatechange") this.stateListeners.add(listener);
  }

  removeEventListener(type: "connectionstatechange", listener: () => void): void {
    if (type === "connectionstatechange") this.stateListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }

  transition(state: string): void {
    this.connectionState = state;
    for (const listener of this.stateListeners) listener();
  }
}

function fixtures() {
  const peer = new FakePeerConnection();
  const track = {
    stopCalls: 0,
    stop() {
      this.stopCalls += 1;
    },
  };
  const stream: OpenAIMediaStreamLike = { getTracks: () => [track] };
  const fetchCalls: Array<{ input: string; init: RequestInit | undefined }> = [];
  const mintCalls: unknown[] = [];
  const events: TranscriptionEvent[] = [];
  const provider = new OpenAIRealtimeTranscriptionProvider({
    mediaDevices: {
      getUserMedia: async (constraints) => {
        expect(constraints).toEqual({ audio: true });
        return stream;
      },
    },
    createPeerConnection: () => peer,
    mintClientSecret: async (request) => {
      mintCalls.push(request);
      return {
        value: "ephemeral-secret",
        expiresAt: 2_000_000_000,
        providerSessionId: "provider-session-1",
      };
    },
    fetch: async (input, init) => {
      fetchCalls.push({ input: String(input), init });
      return new Response("mock-answer-sdp", {
        status: 201,
        headers: { "content-type": "application/sdp" },
      });
    },
  });
  const session = provider.createSession(
    {
      sessionId: "dictation-1",
      language: "en",
      privacy: {
        retainAudio: false,
        retainTranscript: false,
        trainingAllowed: false,
      },
    },
    (event) => events.push(event),
  );
  return { provider, session, peer, track, fetchCalls, mintCalls, events };
}

describe("OpenAIRealtimeTranscriptionProvider", () => {
  test("opens WebRTC with only an ephemeral secret and canonicalizes delta/final/usage", async () => {
    const { session, peer, track, fetchCalls, mintCalls, events } = fixtures();

    await session.start();

    expect(mintCalls).toEqual([
      {
        sessionId: "dictation-1",
        language: "en",
        diarization: false,
        privacy: {
          retainAudio: false,
          retainTranscript: false,
          trainingAllowed: false,
        },
      },
    ]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.input).toBe("https://api.openai.com/v1/realtime/calls");
    expect(fetchCalls[0]?.init?.method).toBe("POST");
    expect(fetchCalls[0]?.init?.body).toBe("mock-offer-sdp");
    expect(new Headers(fetchCalls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer ephemeral-secret",
    );
    expect(new Headers(fetchCalls[0]?.init?.headers).get("content-type")).toBe("application/sdp");
    expect(peer.remoteDescription).toEqual({
      type: "answer",
      sdp: "mock-answer-sdp",
    });
    expect(events[0]).toMatchObject({
      type: "session.ready",
      providerSessionId: "provider-session-1",
      expiresAt: 2_000_000_000,
    });

    peer.channel.message({
      type: "conversation.item.input_audio_transcription.delta",
      event_id: "delta-1",
      item_id: "item-1",
      delta: "hello ",
    });
    peer.channel.message({
      type: "conversation.item.input_audio_transcription.delta",
      event_id: "delta-2",
      item_id: "item-1",
      delta: "world",
    });
    peer.channel.message({
      type: "conversation.item.input_audio_transcription.completed",
      event_id: "completed-1",
      item_id: "item-1",
      transcript: "hello world",
      usage: { type: "duration", seconds: 1.75 },
    });
    // A replay with a different transport event ID cannot produce a second final.
    peer.channel.message({
      type: "conversation.item.input_audio_transcription.completed",
      event_id: "completed-replay",
      item_id: "item-1",
      transcript: "hello world",
      usage: { type: "duration", seconds: 1.75 },
    });

    expect(events.filter((event) => event.type === "transcript.partial")).toEqual([
      expect.objectContaining({ text: "hello ", providerEventId: "delta-1" }),
      expect.objectContaining({
        text: "hello world",
        providerEventId: "delta-2",
      }),
    ]);
    expect(events.filter((event) => event.type === "transcript.final")).toEqual([
      expect.objectContaining({
        text: "hello world",
        providerAcceptanceId: "completed-1",
        logicalSegmentId: "dictation-1:item-1",
      }),
    ]);
    expect(events.filter((event) => event.type === "usage")).toEqual([
      expect.objectContaining({
        providerEventId: "completed-1:usage",
        usage: { unit: "duration_seconds", seconds: 1.75 },
      }),
    ]);

    await session.cancel();
    expect(track.stopCalls).toBe(1);
    expect(peer.channel.closed).toBe(true);
    expect(peer.closed).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "closed",
      reason: "cancelled",
    });
  });

  test("emits reconnect and failure semantics without committing an unfinished partial", async () => {
    const { session, peer, track, events } = fixtures();
    await session.start();
    peer.channel.message({
      type: "conversation.item.input_audio_transcription.delta",
      event_id: "delta-1",
      item_id: "item-1",
      delta: "unfinished",
    });

    peer.transition("disconnected");
    peer.transition("connected");
    peer.channel.message({
      type: "conversation.item.input_audio_transcription.failed",
      event_id: "failed-1",
      item_id: "item-1",
      error: {
        code: "audio_unintelligible",
        message: "Could not transcribe audio.",
      },
    });

    expect(events).toContainEqual(expect.objectContaining({ type: "reconnecting", attempt: 1 }));
    expect(events.filter((event) => event.type === "session.ready")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "audio_unintelligible",
      message: "Voice dictation could not transcribe this audio. Please retry.",
      retryable: true,
    });
    expect(events.some((event) => event.type === "transcript.final")).toBe(false);
    expect(track.stopCalls).toBe(1);
    expect(peer.channel.closed).toBe(true);
    expect(peer.closed).toBe(true);
  });

  test("cleans up media after a generic provider error", async () => {
    const { session, peer, track, events } = fixtures();
    await session.start();

    peer.channel.message({
      type: "error",
      event_id: "error-1",
      error: {
        code: "rate_limit_exceeded",
        message: "internal provider detail",
      },
    });

    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "rate_limit_exceeded",
      message: "The voice dictation provider returned an error. Please retry.",
      retryable: true,
    });
    expect(track.stopCalls).toBe(1);
    expect(peer.channel.closed).toBe(true);
    expect(peer.closed).toBe(true);
  });

  test("cleans up media after a failed voice connection", async () => {
    const { session, peer, track, events } = fixtures();
    await session.start();

    peer.transition("failed");

    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "webrtc_failed",
      message: "The voice connection failed. Please retry.",
      retryable: true,
    });
    expect(track.stopCalls).toBe(1);
    expect(peer.channel.closed).toBe(true);
    expect(peer.closed).toBe(true);
  });

  test("emits provider closure and cleans up media after the connection closes", async () => {
    const { session, peer, track, events } = fixtures();
    await session.start();

    peer.transition("closed");

    expect(events.at(-1)).toMatchObject({
      type: "closed",
      reason: "provider_closed",
    });
    expect(track.stopCalls).toBe(1);
    expect(peer.channel.closed).toBe(true);
    expect(peer.closed).toBe(true);
  });

  test("cleans up media and rejects a failed SDP exchange without exposing the platform key", async () => {
    const peer = new FakePeerConnection();
    const track = {
      stopCalls: 0,
      stop() {
        this.stopCalls += 1;
      },
    };
    const provider = new OpenAIRealtimeTranscriptionProvider({
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [track] }),
      },
      createPeerConnection: () => peer,
      mintClientSecret: async () => ({
        value: "ephemeral-only",
        expiresAt: 2_000_000_000,
        providerSessionId: "provider-session-1",
      }),
      fetch: async () => new Response("provider unavailable", { status: 503 }),
    });
    const session = provider.createSession(
      {
        sessionId: "dictation-1",
        privacy: {
          retainAudio: false,
          retainTranscript: false,
          trainingAllowed: false,
        },
      },
      () => {},
    );

    await expect(session.start()).rejects.toThrow("OpenAI Realtime SDP exchange failed (503)");
    expect(track.stopCalls).toBe(1);
    expect(peer.closed).toBe(true);
  });

  test("does not continue setup when closed while microphone permission is pending", async () => {
    const track = {
      stopCalls: 0,
      stop() {
        this.stopCalls += 1;
      },
    };
    let resolveMedia!: (stream: OpenAIMediaStreamLike) => void;
    const media = new Promise<OpenAIMediaStreamLike>((resolve) => {
      resolveMedia = resolve;
    });
    let mintCalls = 0;
    let peerCalls = 0;
    const provider = new OpenAIRealtimeTranscriptionProvider({
      mediaDevices: { getUserMedia: async () => await media },
      createPeerConnection: () => {
        peerCalls += 1;
        return new FakePeerConnection();
      },
      mintClientSecret: async () => {
        mintCalls += 1;
        return {
          value: "ephemeral-only",
          expiresAt: 2_000_000_000,
          providerSessionId: "provider-session-1",
        };
      },
    });
    const session = provider.createSession(
      {
        sessionId: "dictation-1",
        privacy: {
          retainAudio: false,
          retainTranscript: false,
          trainingAllowed: false,
        },
      },
      () => {},
    );

    const starting = session.start();
    await session.close();
    resolveMedia({ getTracks: () => [track] });

    await expect(starting).rejects.toThrow("Voice dictation was closed");
    expect(track.stopCalls).toBe(1);
    expect(mintCalls).toBe(0);
    expect(peerCalls).toBe(0);
  });

  test("rejects region constraints the prototype cannot enforce before acquiring media", () => {
    let mediaCalls = 0;
    const provider = new OpenAIRealtimeTranscriptionProvider({
      mediaDevices: {
        getUserMedia: async () => {
          mediaCalls += 1;
          return { getTracks: () => [] };
        },
      },
      mintClientSecret: async () => ({
        value: "unused",
        expiresAt: 2_000_000_000,
        providerSessionId: "unused",
      }),
    });

    expect(() =>
      provider.createSession(
        {
          sessionId: "dictation-1",
          privacy: {
            retainAudio: false,
            retainTranscript: false,
            trainingAllowed: false,
            region: "eu-west",
          },
        },
        () => {},
      ),
    ).toThrow("cannot guarantee a requested region or data residency");
    expect(mediaCalls).toBe(0);
  });

  test("rejects unsafe retention or training settings before acquiring media", () => {
    let mediaCalls = 0;
    const provider = new OpenAIRealtimeTranscriptionProvider({
      mediaDevices: {
        getUserMedia: async () => {
          mediaCalls += 1;
          return { getTracks: () => [] };
        },
      },
      mintClientSecret: async () => ({
        value: "unused",
        expiresAt: 2_000_000_000,
        providerSessionId: "unused",
      }),
    });

    expect(() =>
      provider.createSession(
        {
          sessionId: "dictation-1",
          privacy: {
            retainAudio: true,
            retainTranscript: false,
            trainingAllowed: false,
          },
        },
        () => {},
      ),
    ).toThrow("requires no-retention and no-training privacy settings");
    expect(() =>
      provider.createSession(
        {
          sessionId: "dictation-2",
          privacy: {
            retainAudio: false,
            retainTranscript: false,
            trainingAllowed: true,
          },
        },
        () => {},
      ),
    ).toThrow("requires no-retention and no-training privacy settings");
    expect(mediaCalls).toBe(0);
  });
});
