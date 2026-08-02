import { describe, expect, test } from "bun:test";
import {
  createCodexRealtimeController,
  projectSessionRealtimeLifecycle,
} from "../src/codex-realtime-controller";
import { CODEX_REALTIME_V3_PENDING_MAX_BYTES } from "../src/codex-realtime-v3";
import { OpenGeniApiError } from "../src/errors";
import type {
  CodexRealtimeWebrtcRequest,
  CodexRealtimeWebrtcResponse,
  SessionEvent,
  SessionRealtimeMode,
  SyncSessionRealtimeLedgerRequest,
  SyncSessionRealtimeLedgerResponse,
} from "../src/types";
import { SESSION_ID, WORKSPACE_ID } from "./helpers";

const REALTIME_ID = "33333333-3333-4333-8333-333333333333";
const CONNECTION_ID = "44444444-4444-4444-8444-444444444444";
const OFFER = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const ANSWER = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

function mode(overrides: Partial<SessionRealtimeMode> = {}): SessionRealtimeMode {
  return {
    id: REALTIME_ID,
    sessionId: SESSION_ID,
    operationId: "11111111-1111-4111-8111-111111111111",
    browserInstanceId: "22222222-2222-4222-8222-222222222222",
    model: "gpt-live-1-boulder-alpha",
    state: "active",
    version: 1,
    connectionEpoch: 1,
    leaseExpiresAt: "2026-07-29T07:00:30.000Z",
    lastHeartbeatAt: "2026-07-29T07:00:00.000Z",
    startedAt: "2026-07-29T07:00:00.000Z",
    endedAt: null,
    endReason: null,
    ...overrides,
  };
}

function uuidSource() {
  const values = [
    "22222222-2222-4222-8222-222222222222",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "11111111-1111-4111-8111-111111111111",
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-8888-888888888888",
  ];
  return () => values.shift() ?? "99999999-9999-4999-8999-999999999999";
}

function browserFixture(
  options: {
    onSetRemoteDescription?: (() => void) | undefined;
    initialEventsReadyState?: RTCDataChannelState | undefined;
  } = {},
) {
  const calls: string[] = [];
  const sent: string[] = [];
  const track = { kind: "audio", stop: () => calls.push("track.stop") };
  const remoteTrack = { kind: "audio" };
  const media = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const remoteMedia = { getTracks: () => [remoteTrack] } as unknown as MediaStream;
  let eventsReadyState = options.initialEventsReadyState ?? "open";
  const events = new EventTarget() as RTCDataChannel;
  Object.defineProperties(events, {
    label: { value: "oai-events" },
    readyState: { get: () => eventsReadyState },
    send: { value: (value: string) => sent.push(value) },
    close: {
      value: () => {
        eventsReadyState = "closed";
        calls.push("events.close");
      },
    },
  });
  let localDescription: RTCSessionDescription | null = null;
  const peer = new EventTarget() as RTCPeerConnection;
  Object.defineProperties(peer, {
    localDescription: { get: () => localDescription },
    createDataChannel: {
      value: (label: string) => {
        calls.push(`data:${label}`);
        return events;
      },
    },
    addTrack: { value: () => (calls.push("addTrack"), {} as RTCRtpSender) },
    createOffer: { value: async () => ({ type: "offer" as const, sdp: OFFER }) },
    setLocalDescription: {
      value: async (description: RTCSessionDescriptionInit) => {
        localDescription = description as RTCSessionDescription;
      },
    },
    setRemoteDescription: {
      value: async (description: RTCSessionDescriptionInit) => {
        calls.push(`setRemoteDescription:${description.type}`);
        expect(description).toEqual({ type: "answer", sdp: ANSWER });
        options.onSetRemoteDescription?.();
      },
    },
    close: { value: () => calls.push("peer.close") },
  });
  const remoteAudio = {
    autoplay: false,
    playsInline: false,
    srcObject: null,
    play: async () => {
      calls.push("audio.play");
    },
    pause: () => calls.push("audio.pause"),
  } as unknown as HTMLAudioElement;
  const dispatchRemoteTrack = () => {
    const event = new Event("track") as RTCTrackEvent;
    Object.defineProperties(event, {
      track: { value: remoteTrack },
      streams: { value: [remoteMedia] },
    });
    peer.dispatchEvent(event);
  };
  return {
    calls,
    sent,
    media,
    events,
    peer,
    remoteAudio,
    remoteMedia,
    dispatchRemoteTrack,
    openEvents: () => {
      eventsReadyState = "open";
      events.dispatchEvent(new Event("open"));
    },
  };
}

function storageFixture(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

function noIntervals() {
  return {
    setInterval: (_callback: () => void, _delay: number) => 1,
    clearInterval: (_handle: unknown) => undefined,
  };
}

function timerFixture() {
  let nextId = 1;
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  const timeouts = new Map<number, { callback: () => void; delay: number }>();
  return {
    setInterval: (callback: () => void, delay: number) => {
      const id = nextId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: (handle: unknown) => intervals.delete(Number(handle)),
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextId++;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (handle: unknown) => timeouts.delete(Number(handle)),
    runTimeout(delay: number) {
      const match = [...timeouts].find(([, timer]) => timer.delay === delay);
      if (!match) throw new Error(`No timeout scheduled for ${delay}ms`);
      const [id, timer] = match;
      timeouts.delete(id);
      timer.callback();
    },
    runInterval(delay: number) {
      const match = [...intervals].find(([, timer]) => timer.delay === delay);
      if (!match) throw new Error(`No interval scheduled for ${delay}ms`);
      match[1].callback();
    },
    timeoutDelays: () => [...timeouts.values()].map((timer) => timer.delay).sort((a, b) => a - b),
    intervalDelays: () => [...intervals.values()].map((timer) => timer.delay).sort((a, b) => a - b),
  };
}

function rotatingBrowserFixture() {
  const calls: string[] = [];
  const peers: Array<{
    peer: RTCPeerConnection;
    events: RTCDataChannel;
    sent: string[];
    setState(state: RTCPeerConnectionState, ice?: RTCIceConnectionState): void;
    dispatchRemoteTrack(): void;
  }> = [];
  const tracks: MediaStreamTrack[] = [];
  const endTracks: Array<() => void> = [];
  const media: MediaStream[] = [];
  let getUserMediaCalls = 0;
  let rejectPlay = false;
  const remoteAudio = {
    autoplay: false,
    srcObject: null,
    play: async () => {
      calls.push("audio.play");
      if (rejectPlay) throw new DOMException("gesture required", "NotAllowedError");
    },
    pause: () => calls.push("audio.pause"),
  } as unknown as HTMLAudioElement;

  const getUserMedia = async (): Promise<MediaStream> => {
    getUserMediaCalls += 1;
    let readyState: MediaStreamTrackState = "live";
    const track = new EventTarget() as MediaStreamTrack;
    Object.defineProperties(track, {
      kind: { value: "audio" },
      enabled: { value: true, writable: true },
      readyState: { get: () => readyState },
      stop: {
        value: () => {
          calls.push(`track.${tracks.indexOf(track)}.stop`);
          readyState = "ended";
        },
      },
    });
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    tracks.push(track);
    endTracks.push(() => {
      if (readyState === "ended") return;
      readyState = "ended";
      track.dispatchEvent(new Event("ended"));
    });
    media.push(stream);
    return stream;
  };

  const createPeerConnection = (): RTCPeerConnection => {
    const index = peers.length;
    const sent: string[] = [];
    let localDescription: RTCSessionDescription | null = null;
    let connectionState: RTCPeerConnectionState = "connected";
    let iceConnectionState: RTCIceConnectionState = "connected";
    const events = new EventTarget() as RTCDataChannel;
    Object.defineProperties(events, {
      label: { value: "oai-events" },
      readyState: { value: "open" },
      send: { value: (payload: string) => sent.push(payload) },
      close: { value: () => calls.push(`events.${index}.close`) },
    });
    const remoteTrack = { kind: "audio" };
    const remoteMedia = { getTracks: () => [remoteTrack] } as unknown as MediaStream;
    const peer = new EventTarget() as RTCPeerConnection;
    Object.defineProperties(peer, {
      localDescription: { get: () => localDescription },
      connectionState: { get: () => connectionState },
      iceConnectionState: { get: () => iceConnectionState },
      createDataChannel: { value: () => events },
      addTrack: { value: () => (calls.push(`peer.${index}.addTrack`), {} as RTCRtpSender) },
      createOffer: { value: async () => ({ type: "offer" as const, sdp: OFFER }) },
      setLocalDescription: {
        value: async (description: RTCSessionDescriptionInit) => {
          localDescription = description as RTCSessionDescription;
        },
      },
      setRemoteDescription: { value: async () => undefined },
      close: { value: () => calls.push(`peer.${index}.close`) },
    });
    peers.push({
      peer,
      events,
      sent,
      setState: (state, ice = state === "failed" ? "failed" : "connected") => {
        connectionState = state;
        iceConnectionState = ice;
        peer.dispatchEvent(new Event("connectionstatechange"));
      },
      dispatchRemoteTrack: () => {
        const event = new Event("track") as RTCTrackEvent;
        Object.defineProperties(event, {
          track: { value: remoteTrack },
          streams: { value: [remoteMedia] },
        });
        peer.dispatchEvent(event);
      },
    });
    return peer;
  };

  return {
    calls,
    peers,
    tracks,
    media,
    remoteAudio,
    getUserMedia,
    createPeerConnection,
    getUserMediaCalls: () => getUserMediaCalls,
    rejectPlay: () => {
      rejectPlay = true;
    },
    allowPlay: () => {
      rejectPlay = false;
    },
    endTrack(index: number) {
      const endTrack = endTracks[index];
      if (!endTrack) throw new Error("Missing microphone track");
      endTrack();
    },
  };
}

async function eventually(assertion: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (assertion()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

function dispatchProviderMessage(events: RTCDataChannel, payload: string): void {
  events.dispatchEvent(new MessageEvent("message", { data: payload }));
}

describe("Codex realtime browser controller", () => {
  test("drives normal -> realtime -> normal with real WebRTC/V3 bridge semantics", async () => {
    const browser = browserFixture();
    const storage = storageFixture();
    const syncRequests: SyncSessionRealtimeLedgerRequest[] = [];
    const negotiations: CodexRealtimeWebrtcRequest[] = [];
    let current = mode();
    let firstSync = true;
    let pendingOutbound: SyncSessionRealtimeLedgerResponse["outbound"] = [];
    let heartbeatGate: Promise<void> | null = null;
    const controller = createCodexRealtimeController({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      storage,
      remoteAudio: browser.remoteAudio,
      randomUUID: uuidSource(),
      createPeerConnection: () => browser.peer,
      getUserMedia: async () => browser.media,
      ...noIntervals(),
      client: {
        beginSessionRealtime: async (_workspaceId, _sessionId, request) => {
          expect(request.ownerKey).toStartWith("opengeni-realtime-owner:");
          current = mode({
            operationId: request.operationId,
            browserInstanceId: request.browserInstanceId,
          });
          return { mode: current, replay: false };
        },
        negotiateCodexRealtimeWebrtc: async (_workspaceId, _sessionId, request) => {
          negotiations.push(request);
          const response: CodexRealtimeWebrtcResponse = {
            sdp: ANSWER,
            version: "v3",
            model: "gpt-live-1-boulder-alpha",
            connectionId: CONNECTION_ID,
            connectionEpoch: request.expectedConnectionEpoch,
            startupFenceSequence: 9,
            modeVersion: current.version,
            replay: false,
          };
          return response;
        },
        activateCodexRealtimeConnection: async (
          _workspaceId,
          _sessionId,
          _realtimeId,
          connectionId,
          request,
        ) => {
          expect(connectionId).toBe(CONNECTION_ID);
          expect(request.operationId).toBe(negotiations.at(-1)!.operationId);
          const rotated = request.connectionEpoch !== current.connectionEpoch;
          current = mode({
            ...current,
            version: current.version + (rotated ? 1 : 0),
            connectionEpoch: request.connectionEpoch,
          });
          return { mode: current, replay: false };
        },
        heartbeatSessionRealtime: async (_workspaceId, _sessionId, _realtimeId, request) => {
          expect(request.expectedVersion).toBe(current.version);
          current = mode({
            ...current,
            version: current.version + 1,
            leaseExpiresAt: "2026-07-29T07:00:40.000Z",
          });
          await heartbeatGate;
          return { mode: current, replay: false };
        },
        syncSessionRealtimeLedger: async (_workspaceId, _sessionId, _realtimeId, request) => {
          syncRequests.push(request);
          if (firstSync) {
            firstSync = false;
            return {
              accepted: [],
              outbound: [
                {
                  id: "99999999-9999-4999-8999-999999999999",
                  realtimeId: REALTIME_ID,
                  operationId: "99999999-9999-4999-8999-999999999998",
                  connectionEpoch: 1,
                  sequence: 9,
                  direction: "provider_out",
                  kind: "session_update",
                  role: null,
                  providerEventId: null,
                  delegationItemId: null,
                  sourceUpdateId: "99999999-9999-4999-8999-999999999997",
                  historyItemId: null,
                  turnId: null,
                  text: "A different session finished its durable update.",
                  payload: {},
                  clientAckedAt: null,
                  providerAckedAt: null,
                  createdAt: "2026-07-29T07:00:00.000Z",
                  updatedAt: "2026-07-29T07:00:00.000Z",
                },
              ],
            } satisfies SyncSessionRealtimeLedgerResponse;
          }
          if (pendingOutbound.length > 0) {
            const outbound = pendingOutbound;
            pendingOutbound = [];
            return { accepted: [], outbound };
          }
          return { accepted: [], outbound: [] };
        },
        endSessionRealtime: async (_workspaceId, _sessionId, _realtimeId, request) => {
          expect(request.expectedVersion).toBe(current.version);
          current = mode({
            ...current,
            state: "ended",
            version: current.version + 1,
            endedAt: "2026-07-29T07:00:20.000Z",
            endReason: "user_stop",
          });
          return { mode: current, replay: false };
        },
      },
    });

    await controller.start();
    expect(controller.snapshot().status).toBe("active");
    expect(negotiations).toEqual([
      expect.objectContaining({
        rotate: false,
        expectedVersion: 1,
        expectedConnectionEpoch: 1,
        version: "v3",
      }),
    ]);
    expect(storage.values.size).toBe(1);

    browser.dispatchRemoteTrack();
    await Promise.resolve();
    expect(browser.remoteAudio.srcObject).toBe(browser.remoteMedia);
    expect(browser.calls).toContain("audio.play");

    await controller.ingestProviderEvent(
      JSON.stringify({
        type: "session.started",
        event_id: "provider-started",
        session: { id: "provider-session" },
      }),
    );
    expect(JSON.parse(browser.sent[0]!)).toEqual({
      type: "session.context.append",
      channel: "commentary",
      content: [{ type: "input_text", text: "A different session finished its durable update." }],
    });
    expect(syncRequests.at(-1)).toMatchObject({
      clientAckThroughSequence: 9,
    });
    expect(syncRequests.at(-1)?.providerAckSequences).toBeUndefined();

    const beforeAudioDelta = syncRequests.length;
    await controller.ingestProviderEvent(
      JSON.stringify({ type: "output_audio.delta", delta: "base64-audio-is-ephemeral" }),
    );
    expect(syncRequests).toHaveLength(beforeAudioDelta);
    await controller.ingestProviderEvent(
      JSON.stringify({
        type: "input_transcript.added",
        event_id: "transcript-final",
        item: { id: "input-item", text: "finalized user text" },
      }),
    );
    expect(syncRequests.at(-1)?.entries).toEqual([
      expect.objectContaining({
        kind: "user_transcript",
        providerEventId: "transcript-final",
        text: "finalized user text",
      }),
    ]);
    await controller.ingestProviderEvent(
      JSON.stringify({
        type: "output_transcript.added",
        event_id: "assistant-transcript-final",
        item: { id: "output-item", text: "finalized assistant text" },
      }),
    );
    expect(syncRequests.at(-1)?.entries).toEqual([
      expect.objectContaining({
        kind: "assistant_transcript",
        providerEventId: "assistant-transcript-final",
        text: "finalized assistant text",
      }),
    ]);

    await controller.ingestProviderEvent(
      JSON.stringify({
        type: "delegation.created",
        event_id: "delegation-created-final",
        offset_ms: 250,
        item: {
          id: "delegation-item-1",
          type: "delegation",
          target: "client",
          content: [
            { type: "input_text", text: "Use the ordinary " },
            { type: "input_text", text: "same-session tool path" },
          ],
        },
      }),
    );
    expect(syncRequests.at(-1)?.entries).toEqual([
      expect.objectContaining({
        kind: "delegation_call",
        providerEventId: "delegation-created-final",
        delegationItemId: "delegation-item-1",
        text: "Use the ordinary same-session tool path",
      }),
    ]);
    expect(controller.snapshot().bridge?.activeDelegationId).toBe("delegation-item-1");
    pendingOutbound = [
      {
        id: "12121212-1212-4212-8212-121212121212",
        realtimeId: REALTIME_ID,
        operationId: "13131313-1313-4313-8313-131313131313",
        connectionEpoch: 1,
        sequence: 10,
        direction: "provider_out",
        kind: "delegation_result",
        role: null,
        providerEventId: null,
        delegationItemId: "delegation-item-1",
        sourceUpdateId: null,
        historyItemId: null,
        turnId: "14141414-1414-4414-8414-141414141414",
        text: "ordinary tool path completed",
        payload: {},
        clientAckedAt: null,
        providerAckedAt: null,
        createdAt: "2026-07-29T07:00:10.000Z",
        updatedAt: "2026-07-29T07:00:10.000Z",
      },
    ];
    await controller.flush();
    expect(JSON.parse(browser.sent.at(-1)!)).toEqual({
      type: "delegation.context.append",
      delegation_item_id: "delegation-item-1",
      channel: "speakable",
      content: [{ type: "input_text", text: "ordinary tool path completed" }],
    });
    expect(controller.snapshot().bridge?.activeDelegationId).toBeNull();
    expect(syncRequests.at(-1)).toMatchObject({
      clientAckThroughSequence: 10,
    });
    expect(syncRequests.at(-1)?.providerAckSequences).toBeUndefined();

    await controller.ingestProviderEvent(
      JSON.stringify({
        type: "error",
        event_id: "provider-error-final",
        error: { message: "bounded provider error" },
      }),
    );
    expect(syncRequests.at(-1)?.entries).toEqual([
      expect.objectContaining({
        kind: "error",
        providerEventId: "provider-error-final",
        text: "bounded provider error",
      }),
    ]);

    let releaseHeartbeat!: () => void;
    heartbeatGate = new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    });
    const renewing = controller.heartbeat();
    await eventually(() => current.version === 2, "heartbeat did not reach the server");
    const flushingAfterRenewal = controller.flush();
    releaseHeartbeat();
    await Promise.all([renewing, flushingAfterRenewal]);
    expect(syncRequests.at(-1)?.expectedVersion).toBe(2);
    await controller.stop();
    expect(controller.snapshot().status).toBe("idle");
    expect(storage.values.size).toBe(0);
    expect(browser.calls).toEqual(
      expect.arrayContaining(["events.close", "track.stop", "peer.close", "audio.pause"]),
    );
  });

  test("projects durable lifecycle and never invents ownership after browser proof loss", async () => {
    const started: SessionEvent = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sequence: 10,
      type: "session.realtime.started",
      payload: {
        realtimeId: REALTIME_ID,
        operationId: "11111111-1111-4111-8111-111111111111",
        model: "gpt-live-1-boulder-alpha",
        version: 4,
        connectionEpoch: 2,
        leaseExpiresAt: "2026-07-29T07:00:30.000Z",
      },
      occurredAt: "2026-07-29T07:00:00.000Z",
    };
    const lifecycle = projectSessionRealtimeLifecycle([started]);
    expect(lifecycle).toMatchObject({ state: "active", realtimeId: REALTIME_ID });

    let beginCalls = 0;
    const controller = createCodexRealtimeController({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      storage: storageFixture(),
      randomUUID: uuidSource(),
      ...noIntervals(),
      client: {
        beginSessionRealtime: async () => {
          beginCalls += 1;
          return { mode: mode(), replay: true };
        },
        negotiateCodexRealtimeWebrtc: async () => {
          throw new Error("must not negotiate without same-browser owner proof");
        },
        activateCodexRealtimeConnection: async () => {
          throw new Error("must not activate without same-browser owner proof");
        },
        heartbeatSessionRealtime: async () => ({ mode: mode(), replay: true }),
        syncSessionRealtimeLedger: async () => ({ accepted: [], outbound: [] }),
        endSessionRealtime: async () => ({ mode: mode({ state: "ended" }), replay: true }),
      },
    });
    await controller.observeLifecycle(lifecycle);
    expect(controller.snapshot()).toMatchObject({
      status: "lost_owner",
      realtimeId: REALTIME_ID,
    });
    expect(beginCalls).toBe(0);
    await expect(controller.start()).rejects.toThrow("another browser owner");

    const ended = projectSessionRealtimeLifecycle([
      started,
      {
        ...started,
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sequence: 11,
        type: "session.realtime.ended",
        payload: {
          realtimeId: REALTIME_ID,
          operationId: "11111111-1111-4111-8111-111111111111",
          reason: "lease_expired",
          version: 5,
          connectionEpoch: 2,
        },
      },
    ]);
    await controller.observeLifecycle(ended);
    expect(controller.snapshot().status).toBe("idle");
  });

  test("replays persisted same-browser ownership and rotates the dead browser connection", async () => {
    const browser = browserFixture();
    const operationId = "11111111-1111-4111-8111-111111111111";
    const browserInstanceId = "22222222-2222-4222-8222-222222222222";
    const ownerKey = "opengeni-realtime-owner:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const key = `opengeni:codex-realtime-owner:${WORKSPACE_ID}:${SESSION_ID}`;
    const storage = storageFixture({
      [key]: JSON.stringify({
        version: 1,
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        operationId,
        browserInstanceId,
        ownerKey,
      }),
    });
    const negotiations: CodexRealtimeWebrtcRequest[] = [];
    let beginCalls = 0;
    const controller = createCodexRealtimeController({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      storage,
      remoteAudio: browser.remoteAudio,
      randomUUID: uuidSource(),
      createPeerConnection: () => browser.peer,
      getUserMedia: async () => browser.media,
      ...noIntervals(),
      client: {
        beginSessionRealtime: async (_workspaceId, _sessionId, request) => {
          beginCalls += 1;
          expect(request).toMatchObject({ operationId, browserInstanceId, ownerKey });
          return {
            mode: mode({ operationId, browserInstanceId, version: 4, connectionEpoch: 2 }),
            replay: true,
          };
        },
        negotiateCodexRealtimeWebrtc: async (_workspaceId, _sessionId, request) => {
          negotiations.push(request);
          return {
            sdp: ANSWER,
            version: "v3",
            model: "gpt-live-1-boulder-alpha",
            connectionId: CONNECTION_ID,
            connectionEpoch: 3,
            startupFenceSequence: 0,
            modeVersion: 4,
            replay: false,
          };
        },
        activateCodexRealtimeConnection: async (
          _workspaceId,
          _sessionId,
          _realtimeId,
          connectionId,
          request,
        ) => {
          expect(connectionId).toBe(CONNECTION_ID);
          expect(request).toMatchObject({
            expectedVersion: 5,
            expectedConnectionEpoch: 2,
            connectionEpoch: 3,
          });
          return {
            mode: mode({ operationId, browserInstanceId, version: 6, connectionEpoch: 3 }),
            replay: false,
          };
        },
        heartbeatSessionRealtime: async () => ({
          mode: mode({ operationId, browserInstanceId, version: 5, connectionEpoch: 2 }),
          replay: false,
        }),
        syncSessionRealtimeLedger: async () => ({ accepted: [], outbound: [] }),
        endSessionRealtime: async () => ({
          mode: mode({ state: "ended", version: 6, connectionEpoch: 3 }),
          replay: false,
        }),
      },
    });

    expect(controller.snapshot().status).toBe("recovering");
    // A bounded tail may omit this mode's start while still containing a prior
    // mode's end. Persisted proof replays the newer exact operation instead of
    // clearing it or briefly enabling ordinary controls.
    await controller.observeLifecycle({
      state: "ended",
      realtimeId: "abababab-abab-4bab-8bab-abababababab",
      operationId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
      version: 8,
      connectionEpoch: 2,
      reason: "user_stop",
    });
    expect(beginCalls).toBe(1);
    expect(negotiations).toEqual([
      expect.objectContaining({
        rotate: true,
        expectedVersion: 5,
        expectedConnectionEpoch: 2,
        browserInstanceId,
        ownerKey,
      }),
    ]);
    expect(controller.snapshot()).toMatchObject({
      status: "active",
      realtimeId: REALTIME_ID,
      mode: { version: 6, connectionEpoch: 3 },
    });
    controller.close();
    expect(storage.values.has(key)).toBe(true);
  });

  test("rotates at OpenGeni's proactive-rotation interval, reuses media, and retires the old generation only after activation", async () => {
    const browser = rotatingBrowserFixture();
    const timers = timerFixture();
    const storage = storageFixture();
    const negotiations: CodexRealtimeWebrtcRequest[] = [];
    const activations: Array<{ connectionId: string; request: { connectionEpoch: number } }> = [];
    let pendingUpdate = false;
    let current = mode();
    let releaseSecondActivation!: () => void;
    const secondActivation = new Promise<void>((resolve) => {
      releaseSecondActivation = resolve;
    });
    let uuid = 0;
    const controller = createCodexRealtimeController({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      storage,
      remoteAudio: browser.remoteAudio,
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
      createPeerConnection: browser.createPeerConnection,
      getUserMedia: browser.getUserMedia,
      connectionRotationIntervalMs: 900,
      reconnectBackoffMs: [10, 20],
      ...timers,
      client: {
        beginSessionRealtime: async (_workspaceId, _sessionId, request) => {
          current = mode({
            operationId: request.operationId,
            browserInstanceId: request.browserInstanceId,
          });
          return { mode: current, replay: false };
        },
        negotiateCodexRealtimeWebrtc: async (_workspaceId, _sessionId, request) => {
          negotiations.push(request);
          const connectionEpoch = request.rotate
            ? current.connectionEpoch + 1
            : current.connectionEpoch;
          return {
            sdp: ANSWER,
            version: "v3",
            model: "gpt-live-1-boulder-alpha",
            connectionId: `10000000-0000-4000-8000-${String(negotiations.length).padStart(12, "0")}`,
            connectionEpoch,
            startupFenceSequence: 0,
            modeVersion: current.version,
            replay: false,
          };
        },
        activateCodexRealtimeConnection: async (
          _workspaceId,
          _sessionId,
          _realtimeId,
          connectionId,
          request,
        ) => {
          activations.push({ connectionId, request });
          if (activations.length === 2) await secondActivation;
          const rotated = request.connectionEpoch !== current.connectionEpoch;
          current = mode({
            ...current,
            version: current.version + (rotated ? 1 : 0),
            connectionEpoch: request.connectionEpoch,
          });
          return { mode: current, replay: false };
        },
        heartbeatSessionRealtime: async () => ({ mode: current, replay: false }),
        syncSessionRealtimeLedger: async () => {
          if (!pendingUpdate) return { accepted: [], outbound: [] };
          pendingUpdate = false;
          return {
            accepted: [],
            outbound: [
              {
                id: "12000000-0000-4000-8000-000000000001",
                realtimeId: REALTIME_ID,
                operationId: "12000000-0000-4000-8000-000000000002",
                connectionEpoch: 1,
                sequence: 1,
                direction: "provider_out",
                kind: "session_update",
                role: null,
                providerEventId: null,
                delegationItemId: null,
                sourceUpdateId: "12000000-0000-4000-8000-000000000003",
                historyItemId: null,
                turnId: null,
                text: "Update delivered while the replacement is pending",
                payload: {},
                clientAckedAt: null,
                providerAckedAt: null,
                createdAt: "2026-07-29T07:00:00.000Z",
                updatedAt: "2026-07-29T07:00:00.000Z",
              },
            ],
          };
        },
        endSessionRealtime: async () => ({
          mode: mode({
            ...current,
            state: "ended",
            version: current.version + 1,
            endedAt: "2026-07-29T07:01:00.000Z",
            endReason: "user_stop",
          }),
          replay: false,
        }),
      },
    });

    await controller.start();
    expect(controller.snapshot()).toMatchObject({ status: "active", connectionGeneration: 1 });
    expect(browser.getUserMediaCalls()).toBe(1);
    expect(timers.timeoutDelays()).toContain(900);
    browser.rejectPlay();
    browser.peers[0]!.dispatchRemoteTrack();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.snapshot().audibleOutput).toBe("blocked");
    browser.allowPlay();
    expect(await controller.retryAudibleOutput()).toBe(true);
    expect(controller.snapshot().audibleOutput).toBe("audible");
    expect(negotiations).toHaveLength(1);
    expect(browser.tracks[0]?.enabled).toBe(true);

    timers.runTimeout(900);
    timers.runTimeout(0);
    await eventually(() => activations.length === 2, "rotation did not reach browser activation");
    expect(controller.snapshot()).toMatchObject({ status: "recovering", connectionGeneration: 2 });
    expect(browser.calls).not.toContain("peer.0.close");
    expect(browser.getUserMediaCalls()).toBe(1);
    expect(negotiations[1]).toMatchObject({ rotate: true, expectedConnectionEpoch: 1 });
    pendingUpdate = true;
    timers.runInterval(1_000);
    await eventually(
      () => browser.peers[0]!.sent.length > 0,
      "old active connection did not receive an update during rotation",
    );
    expect(JSON.parse(browser.peers[0]!.sent[0]!)).toMatchObject({
      type: "session.context.append",
    });
    expect(browser.peers[1]!.sent).toEqual([]);

    releaseSecondActivation();
    await eventually(
      () =>
        controller.snapshot().status === "active" &&
        controller.snapshot().connectionGeneration === 2,
      "rotation did not promote the replacement",
    );
    expect(controller.snapshot().mode).toMatchObject({ version: 2, connectionEpoch: 2 });
    expect(browser.calls).toContain("peer.0.close");
    expect(browser.calls).not.toContain("track.0.stop");

    const callsBeforeStaleFailure = negotiations.length;
    browser.peers[0]!.setState("failed");
    await Promise.resolve();
    expect(negotiations).toHaveLength(callsBeforeStaleFailure);
    expect(controller.snapshot()).toMatchObject({ status: "active", connectionGeneration: 2 });

    await controller.stop();
    expect(controller.snapshot().status).toBe("idle");
    expect(browser.calls.filter((call) => call === "track.0.stop")).toHaveLength(1);
    expect(browser.calls).toEqual(expect.arrayContaining(["peer.1.close", "events.1.close"]));
  });

  test("coalesces duplicate peer failures and retries with capped backoff until one replacement succeeds", async () => {
    const browser = rotatingBrowserFixture();
    const timers = timerFixture();
    let current = mode();
    let negotiationCalls = 0;
    let activationCalls = 0;
    let uuid = 100;
    const controller = createCodexRealtimeController({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      storage: storageFixture(),
      remoteAudio: browser.remoteAudio,
      randomUUID: () => `20000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
      createPeerConnection: browser.createPeerConnection,
      getUserMedia: browser.getUserMedia,
      connectionRotationIntervalMs: 900,
      reconnectBackoffMs: [10, 20],
      ...timers,
      client: {
        beginSessionRealtime: async (_workspaceId, _sessionId, request) => {
          current = mode({
            operationId: request.operationId,
            browserInstanceId: request.browserInstanceId,
          });
          return { mode: current, replay: false };
        },
        negotiateCodexRealtimeWebrtc: async (_workspaceId, _sessionId, request) => {
          negotiationCalls += 1;
          if (negotiationCalls === 2) {
            throw new OpenGeniApiError(
              502,
              JSON.stringify({
                error: { message: "temporary negotiation failure", retryable: true },
              }),
            );
          }
          return {
            sdp: ANSWER,
            version: "v3",
            model: "gpt-live-1-boulder-alpha",
            connectionId: `30000000-0000-4000-8000-${String(negotiationCalls).padStart(12, "0")}`,
            connectionEpoch: request.rotate ? current.connectionEpoch + 1 : current.connectionEpoch,
            startupFenceSequence: 0,
            modeVersion: current.version,
            replay: false,
          };
        },
        activateCodexRealtimeConnection: async (
          _workspaceId,
          _sessionId,
          _realtimeId,
          _connectionId,
          request,
        ) => {
          activationCalls += 1;
          const rotated = request.connectionEpoch !== current.connectionEpoch;
          current = mode({
            ...current,
            version: current.version + (rotated ? 1 : 0),
            connectionEpoch: request.connectionEpoch,
          });
          return { mode: current, replay: false };
        },
        heartbeatSessionRealtime: async () => ({ mode: current, replay: false }),
        syncSessionRealtimeLedger: async () => ({ accepted: [], outbound: [] }),
        endSessionRealtime: async () => ({
          mode: mode({
            ...current,
            state: "ended",
            endedAt: "2026-07-29T07:01:00.000Z",
            endReason: "user_stop",
          }),
          replay: false,
        }),
      },
    });

    await controller.start();
    browser.peers[0]!.setState("failed");
    browser.peers[0]!.setState("failed");
    expect(timers.timeoutDelays().filter((delay) => delay === 10)).toHaveLength(1);
    timers.runTimeout(10);
    await eventually(() => negotiationCalls === 2, "first reconnect was not attempted");
    await eventually(() => timers.timeoutDelays().includes(20), "bounded retry was not scheduled");
    expect(browser.calls).not.toContain("peer.0.close");
    expect(controller.snapshot()).toMatchObject({ status: "recovering", reconnectAttempt: 1 });

    timers.runTimeout(20);
    await eventually(
      () =>
        controller.snapshot().status === "active" &&
        controller.snapshot().connectionGeneration === 3,
      "second reconnect did not recover",
    );
    expect(negotiationCalls).toBe(3);
    expect(activationCalls).toBe(2);
    expect(browser.getUserMediaCalls()).toBe(1);
    expect(browser.calls).toContain("peer.0.close");
    expect(controller.snapshot()).toMatchObject({
      reconnectAttempt: 0,
      mode: { connectionEpoch: 2 },
    });
    await controller.stop();
  });

  test("reacquires a lost microphone and retains the old generation until replacement activation", async () => {
    const browser = rotatingBrowserFixture();
    const timers = timerFixture();
    let current = mode();
    let negotiationCalls = 0;
    let activationCalls = 0;
    let releaseReplacement!: () => void;
    const replacementReady = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let uuid = 300;
    const controller = createCodexRealtimeController({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      storage: storageFixture(),
      remoteAudio: browser.remoteAudio,
      randomUUID: () => `60000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
      createPeerConnection: browser.createPeerConnection,
      getUserMedia: browser.getUserMedia,
      connectionRotationIntervalMs: 900,
      reconnectBackoffMs: [10],
      ...timers,
      client: {
        beginSessionRealtime: async (_workspaceId, _sessionId, request) => {
          current = mode({
            ...current,
            operationId: request.operationId,
            browserInstanceId: request.browserInstanceId,
          });
          return { mode: current, replay: false };
        },
        negotiateCodexRealtimeWebrtc: async (_workspaceId, _sessionId, request) => {
          negotiationCalls += 1;
          return {
            sdp: ANSWER,
            version: "v3",
            model: "gpt-live-1-boulder-alpha",
            connectionId: `61000000-0000-4000-8000-${String(negotiationCalls).padStart(12, "0")}`,
            connectionEpoch: request.rotate ? current.connectionEpoch + 1 : current.connectionEpoch,
            startupFenceSequence: 0,
            modeVersion: current.version,
            replay: false,
          };
        },
        activateCodexRealtimeConnection: async (
          _workspaceId,
          _sessionId,
          _realtimeId,
          _connectionId,
          request,
        ) => {
          activationCalls += 1;
          if (activationCalls === 2) await replacementReady;
          const rotated = request.connectionEpoch !== current.connectionEpoch;
          current = mode({
            ...current,
            version: current.version + (rotated ? 1 : 0),
            connectionEpoch: request.connectionEpoch,
          });
          return { mode: current, replay: false };
        },
        heartbeatSessionRealtime: async () => ({ mode: current, replay: false }),
        syncSessionRealtimeLedger: async () => ({ accepted: [], outbound: [] }),
        endSessionRealtime: async () => ({
          mode: mode({
            ...current,
            state: "ended",
            version: current.version + 1,
            endedAt: "2026-07-29T07:01:00.000Z",
            endReason: "user_stop",
          }),
          replay: false,
        }),
      },
    });

    await controller.start();
    browser.endTrack(0);
    expect(controller.snapshot()).toMatchObject({
      status: "recovering",
      microphone: "track_ended",
      diagnostic: { kind: "device_failure", recoverable: true },
    });
    expect(timers.timeoutDelays()).toContain(0);
    timers.runTimeout(0);
    await eventually(() => activationCalls === 2, "device recovery did not reach activation");
    expect(browser.getUserMediaCalls()).toBe(2);
    expect(browser.calls).not.toContain("peer.0.close");
    expect(browser.calls.filter((call) => call === "track.0.stop")).toHaveLength(1);

    releaseReplacement();
    await eventually(
      () =>
        controller.snapshot().status === "active" &&
        controller.snapshot().connectionGeneration === 2,
      "device recovery did not promote the healthy microphone",
    );
    expect(controller.snapshot()).toMatchObject({
      microphone: "active",
      mode: { version: 2, connectionEpoch: 2 },
    });
    expect(browser.calls).toContain("peer.0.close");
    await controller.stop();
    expect(browser.calls.filter((call) => call === "track.0.stop")).toHaveLength(1);
    expect(browser.calls.filter((call) => call === "track.1.stop")).toHaveLength(1);
  });

  test("a terminal 409 fences duplicate callbacks and leaves the owned mode stoppable", async () => {
    const browser = rotatingBrowserFixture();
    const timers = timerFixture();
    let current = mode();
    let negotiationCalls = 0;
    let uuid = 400;
    const controller = createCodexRealtimeController({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      storage: storageFixture(),
      remoteAudio: browser.remoteAudio,
      randomUUID: () => `70000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
      createPeerConnection: browser.createPeerConnection,
      getUserMedia: browser.getUserMedia,
      connectionRotationIntervalMs: 900,
      reconnectBackoffMs: [10],
      ...timers,
      client: {
        beginSessionRealtime: async (_workspaceId, _sessionId, request) => {
          current = mode({
            ...current,
            operationId: request.operationId,
            browserInstanceId: request.browserInstanceId,
          });
          return { mode: current, replay: false };
        },
        negotiateCodexRealtimeWebrtc: async (_workspaceId, _sessionId, request) => {
          negotiationCalls += 1;
          if (negotiationCalls === 2) {
            throw new OpenGeniApiError(
              409,
              JSON.stringify({
                error: {
                  code: "REALTIME_CONNECTION_TERMINAL",
                  message: "Realtime connection cannot be replaced",
                  retryable: false,
                },
              }),
            );
          }
          return {
            sdp: ANSWER,
            version: "v3",
            model: "gpt-live-1-boulder-alpha",
            connectionId: "71000000-0000-4000-8000-000000000001",
            connectionEpoch: request.expectedConnectionEpoch,
            startupFenceSequence: 0,
            modeVersion: current.version,
            replay: false,
          };
        },
        activateCodexRealtimeConnection: async () => ({ mode: current, replay: false }),
        heartbeatSessionRealtime: async () => ({ mode: current, replay: false }),
        syncSessionRealtimeLedger: async () => ({ accepted: [], outbound: [] }),
        endSessionRealtime: async () => {
          current = mode({
            ...current,
            state: "ended",
            version: current.version + 1,
            endedAt: "2026-07-29T07:01:00.000Z",
            endReason: "user_stop",
          });
          return { mode: current, replay: false };
        },
      },
    });

    await controller.start();
    browser.peers[0]!.setState("failed");
    timers.runTimeout(10);
    await eventually(
      () => controller.snapshot().status === "error",
      "terminal 409 was not exposed",
    );
    expect(controller.snapshot()).toMatchObject({
      mode: { state: "active", connectionEpoch: 1 },
      diagnostic: { kind: "negotiation_failure", recoverable: false },
    });
    expect(browser.calls).not.toContain("peer.0.close");
    expect(timers.timeoutDelays()).toEqual([]);

    browser.peers[0]!.setState("failed");
    await Promise.resolve();
    expect(negotiationCalls).toBe(2);
    expect(timers.timeoutDelays()).toEqual([]);
    await expect(controller.retry()).rejects.toThrow("recovery is terminal");
    await controller.observeLifecycle({
      state: "active",
      realtimeId: current.id,
      operationId: current.operationId,
      version: current.version,
      connectionEpoch: current.connectionEpoch,
      leaseExpiresAt: current.leaseExpiresAt,
    });
    expect(negotiationCalls).toBe(2);

    await controller.stop();
    expect(controller.snapshot().status).toBe("idle");
    expect(browser.calls).toEqual(
      expect.arrayContaining(["peer.0.close", "track.0.stop", "events.0.close"]),
    );
  });

  test("stop during replacement negotiation fences a late answer and leaves no reconnect timers", async () => {
    const browser = rotatingBrowserFixture();
    const timers = timerFixture();
    let current = mode();
    let negotiationCalls = 0;
    let activationCalls = 0;
    let releaseLateAnswer!: (answer: CodexRealtimeWebrtcResponse) => void;
    const lateAnswer = new Promise<CodexRealtimeWebrtcResponse>((resolve) => {
      releaseLateAnswer = resolve;
    });
    let uuid = 200;
    const controller = createCodexRealtimeController({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      storage: storageFixture(),
      remoteAudio: browser.remoteAudio,
      randomUUID: () => `40000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
      createPeerConnection: browser.createPeerConnection,
      getUserMedia: browser.getUserMedia,
      connectionRotationIntervalMs: 900,
      reconnectBackoffMs: [10],
      ...timers,
      client: {
        beginSessionRealtime: async (_workspaceId, _sessionId, request) => {
          current = mode({
            operationId: request.operationId,
            browserInstanceId: request.browserInstanceId,
          });
          return { mode: current, replay: false };
        },
        negotiateCodexRealtimeWebrtc: async (_workspaceId, _sessionId, request) => {
          negotiationCalls += 1;
          if (negotiationCalls === 2) return await lateAnswer;
          return {
            sdp: ANSWER,
            version: "v3",
            model: "gpt-live-1-boulder-alpha",
            connectionId: "50000000-0000-4000-8000-000000000001",
            connectionEpoch: request.expectedConnectionEpoch,
            startupFenceSequence: 0,
            modeVersion: current.version,
            replay: false,
          };
        },
        activateCodexRealtimeConnection: async (
          _workspaceId,
          _sessionId,
          _realtimeId,
          _connectionId,
          request,
        ) => {
          activationCalls += 1;
          current = mode({ ...current, connectionEpoch: request.connectionEpoch });
          return { mode: current, replay: false };
        },
        heartbeatSessionRealtime: async () => ({ mode: current, replay: false }),
        syncSessionRealtimeLedger: async () => ({ accepted: [], outbound: [] }),
        endSessionRealtime: async () => ({
          mode: mode({
            ...current,
            state: "ended",
            version: current.version + 1,
            endedAt: "2026-07-29T07:01:00.000Z",
            endReason: "user_stop",
          }),
          replay: false,
        }),
      },
    });

    await controller.start();
    timers.runTimeout(900);
    timers.runTimeout(0);
    await eventually(() => negotiationCalls === 2, "replacement negotiation did not start");
    const stopping = controller.stop();
    releaseLateAnswer({
      sdp: ANSWER,
      version: "v3",
      model: "gpt-live-1-boulder-alpha",
      connectionId: "50000000-0000-4000-8000-000000000002",
      connectionEpoch: 2,
      startupFenceSequence: 0,
      modeVersion: current.version,
      replay: false,
    });
    await stopping;
    expect(activationCalls).toBe(1);
    expect(controller.snapshot().status).toBe("idle");
    expect(timers.timeoutDelays()).toEqual([]);
    expect(browser.calls).toEqual(
      expect.arrayContaining(["peer.0.close", "peer.1.close", "track.0.stop"]),
    );
  });

  test("persists an event emitted synchronously by setRemoteDescription exactly once", async () => {
    const payload = JSON.stringify({
      type: "input_transcript.added",
      event_id: "early-transcript-1",
      item: { id: "early-item-1", text: "captured before transport return" },
    });
    let browser!: ReturnType<typeof browserFixture>;
    browser = browserFixture({
      onSetRemoteDescription: () => dispatchProviderMessage(browser.events, payload),
    });
    const requests: SyncSessionRealtimeLedgerRequest[] = [];
    let current = mode();
    const controller = createCodexRealtimeController({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      storage: storageFixture(),
      randomUUID: uuidSource(),
      createPeerConnection: () => browser.peer,
      getUserMedia: async () => browser.media,
      ...noIntervals(),
      client: {
        beginSessionRealtime: async (_workspaceId, _sessionId, request) => {
          current = mode({
            operationId: request.operationId,
            browserInstanceId: request.browserInstanceId,
          });
          return { mode: current, replay: false };
        },
        heartbeatSessionRealtime: async () => ({ mode: current, replay: false }),
        negotiateCodexRealtimeWebrtc: async () => ({
          sdp: ANSWER,
          version: "v3",
          model: "gpt-live-1-boulder-alpha",
          connectionId: CONNECTION_ID,
          connectionEpoch: 1,
          startupFenceSequence: 0,
          modeVersion: current.version,
          replay: false,
        }),
        activateCodexRealtimeConnection: async () => ({ mode: current, replay: false }),
        syncSessionRealtimeLedger: async (_workspaceId, _sessionId, _realtimeId, request) => {
          requests.push(request);
          return { accepted: [], outbound: [] };
        },
        endSessionRealtime: async () => ({
          mode: mode({ ...current, state: "ended", endReason: "user_stop" }),
          replay: false,
        }),
      },
    });

    await controller.start();
    await controller.flush();

    expect(requests.flatMap((request) => request.entries ?? [])).toEqual([
      expect.objectContaining({
        kind: "user_transcript",
        providerEventId: "early-transcript-1",
        text: "captured before transport return",
      }),
    ]);
    await controller.stop();
  });

  test("aborts a data channel that misses the 20-second open deadline and fences late open", async () => {
    const browser = browserFixture({ initialEventsReadyState: "connecting" });
    const timers = timerFixture();
    let current = mode();
    let activationCalls = 0;
    const controller = createCodexRealtimeController({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      storage: storageFixture(),
      randomUUID: uuidSource(),
      createPeerConnection: () => browser.peer,
      getUserMedia: async () => browser.media,
      reconnectBackoffMs: [10],
      ...timers,
      client: {
        beginSessionRealtime: async (_workspaceId, _sessionId, request) => {
          current = mode({
            operationId: request.operationId,
            browserInstanceId: request.browserInstanceId,
          });
          return { mode: current, replay: false };
        },
        heartbeatSessionRealtime: async () => ({ mode: current, replay: false }),
        negotiateCodexRealtimeWebrtc: async () => ({
          sdp: ANSWER,
          version: "v3",
          model: "gpt-live-1-boulder-alpha",
          connectionId: CONNECTION_ID,
          connectionEpoch: 1,
          startupFenceSequence: 0,
          modeVersion: current.version,
          replay: false,
        }),
        activateCodexRealtimeConnection: async () => {
          activationCalls += 1;
          return { mode: current, replay: false };
        },
        syncSessionRealtimeLedger: async () => ({ accepted: [], outbound: [] }),
        endSessionRealtime: async () => ({
          mode: mode({ ...current, state: "ended", endReason: "user_stop" }),
          replay: false,
        }),
      },
    });

    const starting = controller.start();
    await eventually(
      () => timers.timeoutDelays().includes(20_000),
      "negotiation deadline was not installed",
    );
    await eventually(
      () => browser.calls.includes("setRemoteDescription:answer"),
      "data channel did not reach the open wait",
    );
    timers.runTimeout(20_000);
    await expect(starting).rejects.toThrow("did not open within 20 seconds");
    browser.openEvents();
    await Promise.resolve();

    expect(activationCalls).toBe(0);
    expect(controller.snapshot()).toMatchObject({
      status: "recovering",
      diagnostic: { kind: "reconnect", recoverable: true },
    });
    expect(browser.calls).toEqual(expect.arrayContaining(["events.close", "peer.close"]));
    await controller.stop();
    expect(timers.timeoutDelays()).toEqual([]);
  });

  test("turns early activation FIFO overflow into one fenced recovery without persistence", async () => {
    let browser!: ReturnType<typeof browserFixture>;
    browser = browserFixture({
      onSetRemoteDescription: () => {
        for (let index = 0; index < 257; index += 1) {
          dispatchProviderMessage(
            browser.events,
            JSON.stringify({
              type: "input_transcript.added",
              event_id: `early-${index}`,
              item: { id: `item-${index}`, text: `early-${index}` },
            }),
          );
        }
      },
    });
    const timers = timerFixture();
    const requests: SyncSessionRealtimeLedgerRequest[] = [];
    let current = mode();
    let activationCalls = 0;
    const controller = createCodexRealtimeController({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      storage: storageFixture(),
      randomUUID: uuidSource(),
      createPeerConnection: () => browser.peer,
      getUserMedia: async () => browser.media,
      reconnectBackoffMs: [10],
      ...timers,
      client: {
        beginSessionRealtime: async (_workspaceId, _sessionId, request) => {
          current = mode({
            operationId: request.operationId,
            browserInstanceId: request.browserInstanceId,
          });
          return { mode: current, replay: false };
        },
        heartbeatSessionRealtime: async () => ({ mode: current, replay: false }),
        negotiateCodexRealtimeWebrtc: async () => ({
          sdp: ANSWER,
          version: "v3",
          model: "gpt-live-1-boulder-alpha",
          connectionId: CONNECTION_ID,
          connectionEpoch: 1,
          startupFenceSequence: 0,
          modeVersion: current.version,
          replay: false,
        }),
        activateCodexRealtimeConnection: async () => {
          activationCalls += 1;
          return { mode: current, replay: false };
        },
        syncSessionRealtimeLedger: async (_workspaceId, _sessionId, _realtimeId, request) => {
          requests.push(request);
          return { accepted: [], outbound: [] };
        },
        endSessionRealtime: async () => ({
          mode: mode({ ...current, state: "ended", endReason: "user_stop" }),
          replay: false,
        }),
      },
    });

    await expect(controller.start()).rejects.toThrow(
      "activation event buffer exceeded its hard limit",
    );

    expect(activationCalls).toBe(0);
    expect(requests).toEqual([]);
    expect(controller.snapshot()).toMatchObject({
      status: "recovering",
      diagnostic: { kind: "reconnect", recoverable: true },
    });
    await controller.stop();
  });

  test("fences bridge metadata overflow during early handoff and schedules recovery", async () => {
    const encoder = new TextEncoder();
    const emptyPayloads = Array.from({ length: 128 }, (_, index) =>
      JSON.stringify({
        type: "input_transcript.added",
        event_id: `handoff-${index}`,
        item: { id: `item-${index}`, text: "" },
      }),
    );
    const emptyBytes = emptyPayloads.reduce(
      (total, payload) => total + encoder.encode(payload).byteLength,
      0,
    );
    const textBudget = CODEX_REALTIME_V3_PENDING_MAX_BYTES - emptyBytes;
    const textBytes = Math.floor(textBudget / emptyPayloads.length);
    const remainder = textBudget % emptyPayloads.length;
    const payloads = emptyPayloads.map((_payload, index) =>
      JSON.stringify({
        type: "input_transcript.added",
        event_id: `handoff-${index}`,
        item: {
          id: `item-${index}`,
          text: "x".repeat(textBytes + (index < remainder ? 1 : 0)),
        },
      }),
    );
    expect(payloads.reduce((total, payload) => total + encoder.encode(payload).byteLength, 0)).toBe(
      CODEX_REALTIME_V3_PENDING_MAX_BYTES,
    );

    let browser!: ReturnType<typeof browserFixture>;
    browser = browserFixture({
      onSetRemoteDescription: () => {
        for (const payload of payloads) dispatchProviderMessage(browser.events, payload);
      },
    });
    const timers = timerFixture();
    const requests: SyncSessionRealtimeLedgerRequest[] = [];
    let uuid = 0;
    let current = mode();
    const controller = createCodexRealtimeController({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      storage: storageFixture(),
      randomUUID: () => `61000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
      createPeerConnection: () => browser.peer,
      getUserMedia: async () => browser.media,
      reconnectBackoffMs: [10],
      ...timers,
      client: {
        beginSessionRealtime: async (_workspaceId, _sessionId, request) => {
          current = mode({
            operationId: request.operationId,
            browserInstanceId: request.browserInstanceId,
          });
          return { mode: current, replay: false };
        },
        heartbeatSessionRealtime: async () => ({ mode: current, replay: false }),
        negotiateCodexRealtimeWebrtc: async () => ({
          sdp: ANSWER,
          version: "v3",
          model: "gpt-live-1-boulder-alpha",
          connectionId: CONNECTION_ID,
          connectionEpoch: 1,
          startupFenceSequence: 0,
          modeVersion: current.version,
          replay: false,
        }),
        activateCodexRealtimeConnection: async () => ({ mode: current, replay: false }),
        syncSessionRealtimeLedger: async (_workspaceId, _sessionId, _realtimeId, request) => {
          requests.push(request);
          return { accepted: [], outbound: [] };
        },
        endSessionRealtime: async () => ({
          mode: mode({ ...current, state: "ended", endReason: "user_stop" }),
          replay: false,
        }),
      },
    });

    await expect(controller.start()).rejects.toThrow(
      "durable event buffer exceeded its hard limit",
    );
    expect(requests).toEqual([]);
    expect(controller.snapshot()).toMatchObject({
      status: "recovering",
      diagnostic: { kind: "reconnect", recoverable: true },
    });
    expect(timers.timeoutDelays()).toEqual([10]);
    await controller.stop();
  });

  test("closes an active bridge generation on hard pending overflow without a durable row", async () => {
    const browser = browserFixture();
    const timers = timerFixture();
    const requests: SyncSessionRealtimeLedgerRequest[] = [];
    let uuid = 0;
    let current = mode();
    const controller = createCodexRealtimeController({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      storage: storageFixture(),
      randomUUID: () => `60000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
      createPeerConnection: () => browser.peer,
      getUserMedia: async () => browser.media,
      reconnectBackoffMs: [10],
      ...timers,
      client: {
        beginSessionRealtime: async (_workspaceId, _sessionId, request) => {
          current = mode({
            operationId: request.operationId,
            browserInstanceId: request.browserInstanceId,
          });
          return { mode: current, replay: false };
        },
        heartbeatSessionRealtime: async () => ({ mode: current, replay: false }),
        negotiateCodexRealtimeWebrtc: async () => ({
          sdp: ANSWER,
          version: "v3",
          model: "gpt-live-1-boulder-alpha",
          connectionId: CONNECTION_ID,
          connectionEpoch: 1,
          startupFenceSequence: 0,
          modeVersion: current.version,
          replay: false,
        }),
        activateCodexRealtimeConnection: async () => ({ mode: current, replay: false }),
        syncSessionRealtimeLedger: async (_workspaceId, _sessionId, _realtimeId, request) => {
          requests.push(request);
          return { accepted: [], outbound: [] };
        },
        endSessionRealtime: async () => ({
          mode: mode({ ...current, state: "ended", endReason: "user_stop" }),
          replay: false,
        }),
      },
    });

    await controller.start();
    for (let index = 0; index < 257; index += 1) {
      dispatchProviderMessage(
        browser.events,
        JSON.stringify({
          type: "input_transcript.added",
          event_id: `active-${index}`,
          item: { id: `item-${index}`, text: `active-${index}` },
        }),
      );
    }
    await Promise.resolve();

    expect(requests).toEqual([]);
    expect(controller.snapshot()).toMatchObject({
      status: "recovering",
      bridge: { fatal: { code: "pending_overflow" }, pendingInbound: 256 },
    });
    expect(browser.calls).toEqual(expect.arrayContaining(["events.close", "peer.close"]));
    await controller.stop();
  });
});
