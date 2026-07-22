import { describe, expect, test } from "bun:test";

import {
  OpenAIRealtimeTranscriptionProvider,
  type OpenAIClientSecretRequest,
  type OpenAIDataChannelLike,
  type OpenAIGrantSettlement,
  type OpenAIGrantUsageReport,
  type OpenAIMediaStreamLike,
  type OpenAIPeerConnectionLike,
} from "../src/transcription/openai-realtime";
import type { TranscriptionEvent } from "../src/transcription/types";

const WORKSPACE_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const DICTATION_ID = "22222222-2222-4222-8222-222222222222";

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

  constructor(readonly attempt: number) {}

  addTrack(track: unknown): void {
    this.tracks.push(track);
  }

  createDataChannel(label: string): OpenAIDataChannelLike {
    expect(label).toBe("oai-events");
    return this.channel;
  }

  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    return { type: "offer", sdp: `mock-offer-sdp-${this.attempt}` };
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

async function waitFor(predicate: () => boolean, message = "condition"): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await Bun.sleep(2);
  }
}

function fixtures(
  overrides: Partial<ConstructorParameters<typeof OpenAIRealtimeTranscriptionProvider>[0]> = {},
) {
  const peers: FakePeerConnection[] = [];
  const track = {
    stopCalls: 0,
    stop() {
      this.stopCalls += 1;
    },
  };
  const stream: OpenAIMediaStreamLike = { getTracks: () => [track] };
  const fetchCalls: Array<{ input: string; init: RequestInit | undefined }> = [];
  const mintCalls: Array<{ request: OpenAIClientSecretRequest; signal?: AbortSignal }> = [];
  const usageCalls: OpenAIGrantUsageReport[] = [];
  const settlements: OpenAIGrantSettlement[] = [];
  const events: TranscriptionEvent[] = [];
  const provider = new OpenAIRealtimeTranscriptionProvider({
    sessionId: WORKSPACE_SESSION_ID,
    mediaDevices: {
      getUserMedia: async (constraints) => {
        expect(constraints).toEqual({ audio: true });
        return stream;
      },
    },
    createPeerConnection: () => {
      const peer = new FakePeerConnection(peers.length);
      peers.push(peer);
      return peer;
    },
    mintClientSecret: async (request, signal) => {
      mintCalls.push({ request, ...(signal ? { signal } : {}) });
      const attempt = mintCalls.length - 1;
      return {
        value: `ephemeral-secret-${attempt}`,
        expiresAt: 2_000_000_000 + attempt,
        providerSessionId: `provider-session-${attempt}`,
        grantId: `grant-${attempt}`,
        maxSessionDurationSeconds: 3_600,
      };
    },
    reportUsage: async (report) => {
      usageCalls.push(report);
    },
    settleGrant: async (settlement) => {
      settlements.push(settlement);
    },
    fetch: async (input, init) => {
      fetchCalls.push({ input: String(input), init });
      return new Response(`mock-answer-sdp-${fetchCalls.length - 1}`, {
        status: 201,
        headers: { "content-type": "application/sdp" },
      });
    },
    reconnectDelayMs: 1,
    reconnectTimeoutMs: 50,
    maxReconnectAttempts: 2,
    ...overrides,
  });
  const session = provider.createSession(
    {
      sessionId: DICTATION_ID,
      language: "en",
      privacy: {
        retainAudio: false,
        retainTranscript: false,
        trainingAllowed: false,
      },
    },
    (event) => events.push(event),
  );
  return {
    provider,
    session,
    peers,
    track,
    stream,
    fetchCalls,
    mintCalls,
    usageCalls,
    settlements,
    events,
  };
}

function complete(peer: FakePeerConnection, attempt: number, eventId: string): void {
  peer.channel.message({
    type: "conversation.item.input_audio_transcription.completed",
    event_id: eventId,
    item_id: "shared-item-id",
    transcript: `attempt ${attempt}`,
    usage: { type: "duration", seconds: 1.75 },
  });
}

describe("OpenAIRealtimeTranscriptionProvider", () => {
  test("binds minting to the durable session and canonicalizes accepted provider output", async () => {
    const { session, peers, track, fetchCalls, mintCalls, usageCalls, settlements, events } =
      fixtures();

    await session.start();

    expect(mintCalls.map(({ request }) => request)).toEqual([
      {
        sessionId: WORKSPACE_SESSION_ID,
        requestId: `${DICTATION_ID}:0`,
        language: "en",
        diarization: false,
        privacy: {
          retainAudio: false,
          retainTranscript: false,
          trainingAllowed: false,
        },
      },
    ]);
    expect(mintCalls[0]?.signal?.aborted).toBe(false);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.input).toBe("https://api.openai.com/v1/realtime/calls");
    expect(fetchCalls[0]?.init?.method).toBe("POST");
    expect(fetchCalls[0]?.init?.body).toBe("mock-offer-sdp-0");
    expect(new Headers(fetchCalls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer ephemeral-secret-0",
    );
    expect(new Headers(fetchCalls[0]?.init?.headers).get("content-type")).toBe("application/sdp");
    expect(peers[0]?.remoteDescription).toEqual({
      type: "answer",
      sdp: "mock-answer-sdp-0",
    });
    expect(events[0]).toMatchObject({
      type: "session.ready",
      providerSessionId: "provider-session-0",
      expiresAt: 2_000_000_000,
    });

    peers[0]?.channel.message({
      type: "conversation.item.input_audio_transcription.delta",
      event_id: "delta-1",
      item_id: "shared-item-id",
      delta: "hello ",
    });
    peers[0]?.channel.message({
      type: "conversation.item.input_audio_transcription.delta",
      event_id: "delta-2",
      item_id: "shared-item-id",
      delta: "world",
    });
    complete(peers[0]!, 0, "completed-0");
    complete(peers[0]!, 0, "completed-replay");
    await waitFor(() => usageCalls.length === 1, "one usage report");

    expect(events.filter((event) => event.type === "transcript.partial")).toEqual([
      expect.objectContaining({ text: "hello ", providerEventId: "delta-1", attempt: 0 }),
      expect.objectContaining({ text: "hello world", providerEventId: "delta-2", attempt: 0 }),
    ]);
    expect(events.filter((event) => event.type === "transcript.final")).toEqual([
      expect.objectContaining({
        text: "attempt 0",
        providerAcceptanceId: "completed-0",
        attempt: 0,
        logicalSegmentId: `${DICTATION_ID}:0:shared-item-id`,
      }),
    ]);
    expect(usageCalls).toEqual([
      {
        sessionId: WORKSPACE_SESSION_ID,
        grantId: "grant-0",
        providerSessionId: "provider-session-0",
        providerEventId: "completed-0",
        durationSeconds: 1.75,
      },
    ]);

    await session.close();
    expect(settlements).toEqual([
      {
        sessionId: WORKSPACE_SESSION_ID,
        grantId: "grant-0",
        providerSessionId: "provider-session-0",
        status: "completed",
      },
    ]);
    expect(track.stopCalls).toBe(1);
    expect(peers[0]?.channel.closed).toBe(true);
    expect(peers[0]?.closed).toBe(true);
  });

  test("reconnects with a fresh grant and peer while fencing old provider events", async () => {
    const { session, peers, mintCalls, fetchCalls, settlements, events } = fixtures();
    await session.start();
    complete(peers[0]!, 0, "accepted-0");

    peers[0]?.transition("disconnected");
    await waitFor(
      () =>
        peers.length === 2 && events.filter((event) => event.type === "session.ready").length === 2,
      "fresh peer recovery",
    );

    expect(peers[0]?.closed).toBe(true);
    expect(peers[1]?.closed).toBe(false);
    expect(mintCalls.map(({ request }) => request.requestId)).toEqual([
      `${DICTATION_ID}:0`,
      `${DICTATION_ID}:1`,
    ]);
    expect(fetchCalls.map(({ init }) => init?.body)).toEqual([
      "mock-offer-sdp-0",
      "mock-offer-sdp-1",
    ]);
    expect(settlements[0]).toEqual({
      sessionId: WORKSPACE_SESSION_ID,
      grantId: "grant-0",
      providerSessionId: "provider-session-0",
      status: "replaced",
    });

    // The first transport has had both listeners removed and is also fenced by
    // generation. Neither late provider output nor state changes can mutate the
    // recovered logical session.
    complete(peers[0]!, 0, "late-old-acceptance");
    peers[0]?.transition("failed");
    complete(peers[1]!, 1, "accepted-1");
    complete(peers[1]!, 1, "accepted-1-replay");

    expect(
      events
        .filter(
          (event): event is Extract<TranscriptionEvent, { type: "transcript.final" }> =>
            event.type === "transcript.final",
        )
        .map((event) => ({ attempt: event.attempt, acceptance: event.providerAcceptanceId })),
    ).toEqual([
      { attempt: 0, acceptance: "accepted-0" },
      { attempt: 1, acceptance: "accepted-1" },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "transcript.final",
        logicalSegmentId: `${DICTATION_ID}:1:shared-item-id`,
      }),
    );

    await session.close();
    expect(settlements.at(-1)?.status).toBe("completed");
  });

  test("exhausts bounded fresh-peer recovery and terminates with a sanitized error", async () => {
    const { session, peers, track, mintCalls, settlements, events } = fixtures();
    await session.start();

    peers[0]?.transition("disconnected");
    await waitFor(() => peers.length === 2, "first recovery");
    peers[1]?.transition("failed");
    await waitFor(() => peers.length === 3, "second recovery");
    peers[2]?.transition("disconnected");
    await waitFor(() => track.stopCalls === 1, "terminal cleanup");

    expect(mintCalls).toHaveLength(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "webrtc_reconnect_exhausted",
        message: "The voice connection could not recover. Please retry.",
        retryable: true,
      }),
    );
    expect(settlements.map((settlement) => settlement.status)).toEqual([
      "replaced",
      "replaced",
      "error",
    ]);
    expect(peers.every((peer) => peer.closed)).toBe(true);
  });

  test("bounds a hanging mint, aborts it, and cleans microphone media", async () => {
    let mintSignal: AbortSignal | undefined;
    const { session, peers, track } = fixtures({
      reconnectTimeoutMs: 10,
      mintClientSecret: async (_request, signal) => {
        mintSignal = signal;
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
            once: true,
          });
        });
      },
    });

    await expect(session.start()).rejects.toThrow("Voice connection setup timed out");
    expect(mintSignal?.aborted).toBe(true);
    expect(peers).toHaveLength(0);
    expect(track.stopCalls).toBe(1);
  });

  test("settles a credential that arrives after its setup deadline", async () => {
    let resolveMint!: (value: {
      value: string;
      expiresAt: number;
      providerSessionId: string;
      grantId: string;
      maxSessionDurationSeconds: number;
    }) => void;
    const mint = new Promise<{
      value: string;
      expiresAt: number;
      providerSessionId: string;
      grantId: string;
      maxSessionDurationSeconds: number;
    }>((resolve) => {
      resolveMint = resolve;
    });
    const { session, track, settlements } = fixtures({
      reconnectTimeoutMs: 10,
      mintClientSecret: async () => await mint,
    });

    await expect(session.start()).rejects.toThrow("Voice connection setup timed out");
    resolveMint({
      value: "late-ephemeral",
      expiresAt: 2_000_000_000,
      providerSessionId: "late-provider-session",
      grantId: "late-grant",
      maxSessionDurationSeconds: 60,
    });
    await waitFor(() => settlements.length === 1, "late grant settlement");

    expect(settlements).toEqual([
      {
        sessionId: WORKSPACE_SESSION_ID,
        grantId: "late-grant",
        providerSessionId: "late-provider-session",
        status: "error",
      },
    ]);
    expect(track.stopCalls).toBe(1);
  });

  test("close aborts pending setup without leaking media or starting a peer", async () => {
    let mintSignal: AbortSignal | undefined;
    let mintStarted = false;
    const { session, peers, track } = fixtures({
      mintClientSecret: async (_request, signal) => {
        mintStarted = true;
        mintSignal = signal;
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
            once: true,
          });
        });
      },
    });

    const starting = session.start();
    await waitFor(() => mintStarted, "pending mint");
    await session.close();

    await expect(starting).rejects.toThrow("Voice dictation was closed");
    expect(mintSignal?.aborted).toBe(true);
    expect(peers).toHaveLength(0);
    expect(track.stopCalls).toBe(1);
  });

  test("settles provider errors and cancellation with their exact terminal status", async () => {
    const providerFailure = fixtures();
    await providerFailure.session.start();
    providerFailure.peers[0]?.channel.message({
      type: "error",
      event_id: "error-1",
      error: { code: "rate_limit_exceeded", message: "internal provider detail" },
    });
    await waitFor(() => providerFailure.settlements.length === 1, "error settlement");
    expect(providerFailure.settlements[0]?.status).toBe("error");
    expect(providerFailure.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "rate_limit_exceeded",
        message: "The voice dictation provider returned an error. Please retry.",
      }),
    );

    const cancelled = fixtures();
    await cancelled.session.start();
    await cancelled.session.cancel();
    expect(cancelled.settlements[0]?.status).toBe("cancelled");
    expect(cancelled.events.at(-1)).toMatchObject({ type: "closed", reason: "cancelled" });
    expect(cancelled.track.stopCalls).toBe(1);
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
      sessionId: WORKSPACE_SESSION_ID,
      mediaDevices: { getUserMedia: async () => await media },
      createPeerConnection: () => {
        peerCalls += 1;
        return new FakePeerConnection(0);
      },
      mintClientSecret: async () => {
        mintCalls += 1;
        return {
          value: "ephemeral-only",
          expiresAt: 2_000_000_000,
          providerSessionId: "provider-session-1",
          grantId: "grant-1",
          maxSessionDurationSeconds: 60,
        };
      },
    });
    const session = provider.createSession(
      {
        sessionId: DICTATION_ID,
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

  test("rejects privacy constraints the adapter cannot guarantee before acquiring media", () => {
    let mediaCalls = 0;
    const provider = new OpenAIRealtimeTranscriptionProvider({
      sessionId: WORKSPACE_SESSION_ID,
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
        grantId: "unused",
        maxSessionDurationSeconds: 60,
      }),
    });

    expect(() =>
      provider.createSession(
        {
          sessionId: DICTATION_ID,
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
    expect(() =>
      provider.createSession(
        {
          sessionId: DICTATION_ID,
          privacy: {
            retainAudio: true,
            retainTranscript: false,
            trainingAllowed: false,
          },
        },
        () => {},
      ),
    ).toThrow("requires no-retention and no-training privacy settings");
    expect(mediaCalls).toBe(0);
  });
});
