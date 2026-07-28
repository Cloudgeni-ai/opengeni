import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import { startCodexRealtimeWebrtc } from "../src/codex-realtime";
import type { CodexRealtimeWebrtcResponse } from "../src/types";
import { SESSION_ID, WORKSPACE_ID } from "./helpers";

const offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const answer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const lifecycleProof = {
  realtimeId: "33333333-3333-4333-8333-333333333333",
  operationId: "22222222-2222-4222-8222-222222222222",
  browserInstanceId: "browser-test",
  ownerKey: "owner-key-11111111-1111-4111-8111-111111111111",
  expectedVersion: 1,
  expectedConnectionEpoch: 1,
  rotate: false,
} as const;
const negotiated: CodexRealtimeWebrtcResponse = {
  sdp: answer,
  version: "v3",
  model: "gpt-live-1-boulder-alpha",
  connectionId: "55555555-5555-4555-8555-555555555555",
  connectionEpoch: 1,
  modeVersion: 1,
  replay: false,
};

function browserFixture() {
  const calls: string[] = [];
  const track = { stop: () => calls.push("track.stop") };
  const media = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const events = {
    label: "oai-events",
    close: () => calls.push("events.close"),
  } as unknown as RTCDataChannel;
  let localDescription: RTCSessionDescription | null = null;
  const peer = {
    get localDescription() {
      return localDescription;
    },
    createDataChannel: (label: string) => {
      calls.push(`data:${label}`);
      return events;
    },
    addTrack: () => {
      calls.push("addTrack");
      return {} as RTCRtpSender;
    },
    createOffer: async () => {
      calls.push("createOffer");
      return { type: "offer" as const, sdp: offer };
    },
    setLocalDescription: async (description: RTCSessionDescriptionInit) => {
      calls.push("setLocalDescription");
      localDescription = description as RTCSessionDescription;
    },
    setRemoteDescription: async (description: RTCSessionDescriptionInit) => {
      calls.push(`setRemoteDescription:${description.type}`);
      expect(description.sdp).toBe(answer);
    },
    close: () => calls.push("peer.close"),
  } as unknown as RTCPeerConnection;
  return { calls, track, media, events, peer };
}

describe("Codex realtime browser negotiation", () => {
  test("adds microphone audio and oai-events, applies the server answer, and stops cleanly", async () => {
    const fixture = browserFixture();
    let capturedSignal: AbortSignal | undefined;
    const session = await startCodexRealtimeWebrtc({
      ...lifecycleProof,
      createPeerConnection: () => fixture.peer,
      getUserMedia: async (constraints) => {
        expect(constraints).toEqual({ audio: true });
        return fixture.media;
      },
      instructions: "Current session context",
      voice: "cove",
      negotiate: async (request, options) => {
        capturedSignal = options.signal;
        expect(request).toEqual({
          ...lifecycleProof,
          sdp: offer,
          version: "v3",
          instructions: "Current session context",
          voice: "cove",
        });
        expect(JSON.stringify(request)).not.toContain("Authorization");
        return negotiated;
      },
    });

    expect(capturedSignal).toBeUndefined();
    expect(session.peerConnection).toBe(fixture.peer);
    expect(session.events).toBe(fixture.events);
    expect(session.media).toBe(fixture.media);
    expect(session.connectionId).toBe(negotiated.connectionId);
    expect(session.connectionEpoch).toBe(1);
    expect(session.modeVersion).toBe(1);
    expect(fixture.calls).toEqual([
      "data:oai-events",
      "addTrack",
      "createOffer",
      "setLocalDescription",
      "setRemoteDescription:answer",
    ]);
    session.stop();
    session.stop();
    expect(fixture.calls.slice(-3)).toEqual(["events.close", "track.stop", "peer.close"]);
  });

  test("cancellation aborts negotiation and closes every browser resource", async () => {
    const fixture = browserFixture();
    const abort = new AbortController();
    let negotiationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      negotiationStarted = resolve;
    });
    const pending = startCodexRealtimeWebrtc({
      ...lifecycleProof,
      signal: abort.signal,
      createPeerConnection: () => fixture.peer,
      getUserMedia: async () => fixture.media,
      negotiate: async (_request, options) => {
        negotiationStarted();
        return await new Promise<CodexRealtimeWebrtcResponse>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    await started;
    abort.abort(new DOMException("Stopped", "AbortError"));
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(fixture.calls.slice(-3)).toEqual(["events.close", "track.stop", "peer.close"]);
  });

  test("an incompatible server version fails closed and cleans up", async () => {
    const fixture = browserFixture();
    await expect(
      startCodexRealtimeWebrtc({
        ...lifecycleProof,
        createPeerConnection: () => fixture.peer,
        getUserMedia: async () => fixture.media,
        negotiate: async () => ({ ...negotiated, version: "v2" as "v3" }),
      }),
    ).rejects.toThrow("incompatible Codex realtime answer");
    expect(fixture.calls.slice(-3)).toEqual(["events.close", "track.stop", "peer.close"]);
  });
});

describe("OpenGeniClient Codex realtime negotiation", () => {
  test("posts lifecycle proof and SDP configuration to the session route and forwards cancellation", async () => {
    const requests: Request[] = [];
    let capturedSignal: AbortSignal | undefined;
    const abort = new AbortController();
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        capturedSignal = init?.signal ?? undefined;
        requests.push(new Request(input, init));
        return new Response(JSON.stringify(negotiated), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const result = await client.negotiateCodexRealtimeWebrtc(
      WORKSPACE_ID,
      SESSION_ID,
      { ...lifecycleProof, sdp: offer, version: "v3", voice: "cove" },
      { signal: abort.signal },
    );
    const captured = requests[0]!;
    expect(result).toEqual(negotiated);
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/realtime/webrtc`,
    );
    expect(capturedSignal).toBe(abort.signal);
    expect(await captured.json()).toEqual({
      ...lifecycleProof,
      sdp: offer,
      version: "v3",
      voice: "cove",
    });
  });

  test("exposes begin, heartbeat, ledger sync, and end mutations on the ordinary session", async () => {
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ mode: {}, replay: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const owner = {
      browserInstanceId: lifecycleProof.browserInstanceId,
      ownerKey: lifecycleProof.ownerKey,
    };
    await client.beginSessionRealtime(WORKSPACE_ID, SESSION_ID, {
      ...owner,
      operationId: "44444444-4444-4444-8444-444444444444",
      model: "gpt-live-1-boulder-alpha",
    });
    await client.heartbeatSessionRealtime(WORKSPACE_ID, SESSION_ID, lifecycleProof.realtimeId, {
      ...owner,
      expectedVersion: 1,
    });
    await client.syncSessionRealtimeLedger(WORKSPACE_ID, SESSION_ID, lifecycleProof.realtimeId, {
      ...owner,
      expectedVersion: 2,
      connectionId: negotiated.connectionId,
      connectionEpoch: 1,
      entries: [
        {
          operationId: "66666666-6666-4666-8666-666666666666",
          kind: "user_transcript",
          text: "final voice input",
        },
      ],
    });
    await client.endSessionRealtime(WORKSPACE_ID, SESSION_ID, lifecycleProof.realtimeId, {
      ...owner,
      expectedVersion: 2,
      reason: "user_stop",
    });

    expect(
      await Promise.all(
        requests.map(async (request) => ({
          method: request.method,
          path: new URL(request.url).pathname,
          body: await request.json(),
        })),
      ),
    ).toEqual([
      {
        method: "POST",
        path: `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/realtime`,
        body: {
          ...owner,
          operationId: "44444444-4444-4444-8444-444444444444",
          model: "gpt-live-1-boulder-alpha",
        },
      },
      {
        method: "PATCH",
        path: `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/realtime/${lifecycleProof.realtimeId}/heartbeat`,
        body: { ...owner, expectedVersion: 1 },
      },
      {
        method: "POST",
        path: `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/realtime/${lifecycleProof.realtimeId}/sync`,
        body: {
          ...owner,
          expectedVersion: 2,
          connectionId: negotiated.connectionId,
          connectionEpoch: 1,
          entries: [
            {
              operationId: "66666666-6666-4666-8666-666666666666",
              kind: "user_transcript",
              text: "final voice input",
            },
          ],
        },
      },
      {
        method: "DELETE",
        path: `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/realtime/${lifecycleProof.realtimeId}`,
        body: { ...owner, expectedVersion: 2, reason: "user_stop" },
      },
    ]);
  });
});
