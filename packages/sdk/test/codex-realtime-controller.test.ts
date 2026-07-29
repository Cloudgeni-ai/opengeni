import { describe, expect, test } from "bun:test";
import {
  createCodexRealtimeController,
  projectSessionRealtimeLifecycle,
} from "../src/codex-realtime-controller";
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

function browserFixture() {
  const calls: string[] = [];
  const sent: string[] = [];
  const track = { kind: "audio", stop: () => calls.push("track.stop") };
  const remoteTrack = { kind: "audio" };
  const media = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const remoteMedia = { getTracks: () => [remoteTrack] } as unknown as MediaStream;
  const events = new EventTarget() as RTCDataChannel;
  Object.defineProperties(events, {
    label: { value: "oai-events" },
    readyState: { value: "open" },
    send: { value: (value: string) => sent.push(value) },
    close: { value: () => calls.push("events.close") },
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
        expect(description).toEqual({ type: "answer", sdp: ANSWER });
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
  return { calls, sent, media, events, peer, remoteAudio, remoteMedia, dispatchRemoteTrack };
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

describe("Codex realtime browser controller", () => {
  test("drives normal -> realtime -> normal with real WebRTC/V3 bridge semantics", async () => {
    const browser = browserFixture();
    const storage = storageFixture();
    const syncRequests: SyncSessionRealtimeLedgerRequest[] = [];
    const negotiations: CodexRealtimeWebrtcRequest[] = [];
    let current = mode();
    let firstSync = true;
    let pendingOutbound: SyncSessionRealtimeLedgerResponse["outbound"] = [];
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
        heartbeatSessionRealtime: async (_workspaceId, _sessionId, _realtimeId, request) => {
          expect(request.expectedVersion).toBe(current.version);
          current = mode({
            ...current,
            version: current.version + 1,
            leaseExpiresAt: "2026-07-29T07:00:40.000Z",
          });
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
      providerAckSequences: [9],
    });

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
    expect(syncRequests.at(-1)).toMatchObject({
      clientAckThroughSequence: 10,
      providerAckSequences: [10],
    });

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

    await controller.heartbeat();
    await controller.flush();
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
            modeVersion: 5,
            replay: false,
          };
        },
        heartbeatSessionRealtime: async () => ({
          mode: mode({ operationId, browserInstanceId, version: 6, connectionEpoch: 3 }),
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
        expectedVersion: 4,
        expectedConnectionEpoch: 2,
        browserInstanceId,
        ownerKey,
      }),
    ]);
    expect(controller.snapshot()).toMatchObject({
      status: "active",
      realtimeId: REALTIME_ID,
      mode: { version: 5, connectionEpoch: 3 },
    });
    controller.close();
    expect(storage.values.has(key)).toBe(true);
  });
});
