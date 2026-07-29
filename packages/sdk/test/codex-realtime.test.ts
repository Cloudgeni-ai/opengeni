import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import { CodexRealtimeMicrophoneError, startCodexRealtimeWebrtc } from "../src/codex-realtime";
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
  startupFenceSequence: 0,
  modeVersion: 1,
  replay: false,
};

function browserFixture() {
  const calls: string[] = [];
  let trackReadyState: MediaStreamTrackState = "live";
  const track = new EventTarget() as MediaStreamTrack;
  Object.defineProperties(track, {
    kind: { value: "audio" },
    enabled: { value: true, writable: true },
    readyState: { get: () => trackReadyState },
    stop: {
      value: () => {
        calls.push("track.stop");
        trackReadyState = "ended";
      },
    },
  });
  const media = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const events = new EventTarget() as RTCDataChannel;
  Object.defineProperties(events, {
    label: { value: "oai-events" },
    readyState: { value: "open" },
    close: { value: () => calls.push("events.close") },
  });
  let localDescription: RTCSessionDescription | null = null;
  const peer = new EventTarget() as RTCPeerConnection;
  let connectionState: RTCPeerConnectionState = "connected";
  let iceConnectionState: RTCIceConnectionState = "connected";
  Object.defineProperties(peer, {
    localDescription: { get: () => localDescription },
    connectionState: { get: () => connectionState },
    iceConnectionState: { get: () => iceConnectionState },
    createDataChannel: {
      value: (label: string) => {
        calls.push(`data:${label}`);
        return events;
      },
    },
    addTrack: {
      value: () => {
        calls.push("addTrack");
        return {} as RTCRtpSender;
      },
    },
    createOffer: {
      value: async () => {
        calls.push("createOffer");
        return { type: "offer" as const, sdp: offer };
      },
    },
    setLocalDescription: {
      value: async (description: RTCSessionDescriptionInit) => {
        calls.push("setLocalDescription");
        localDescription = description as RTCSessionDescription;
      },
    },
    setRemoteDescription: {
      value: async (description: RTCSessionDescriptionInit) => {
        calls.push(`setRemoteDescription:${description.type}`);
        expect(description.sdp).toBe(answer);
      },
    },
    close: { value: () => calls.push("peer.close") },
  });
  const remoteTrack = { kind: "audio" };
  const remoteMedia = { getTracks: () => [remoteTrack] } as unknown as MediaStream;
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
  return {
    calls,
    track,
    media,
    events,
    peer,
    remoteAudio,
    remoteMedia,
    rejectNextPlay: () => {
      rejectPlay = true;
    },
    allowPlay: () => {
      rejectPlay = false;
    },
    dispatchRemoteTrack: () => {
      const event = new Event("track") as RTCTrackEvent;
      Object.defineProperties(event, {
        track: { value: remoteTrack },
        streams: { value: [remoteMedia] },
      });
      peer.dispatchEvent(event);
    },
    endMicrophone: () => {
      trackReadyState = "ended";
      track.dispatchEvent(new Event("ended"));
    },
    setConnectionState: (
      next: RTCPeerConnectionState,
      ice: RTCIceConnectionState = next === "connected" ? "connected" : "disconnected",
    ) => {
      connectionState = next;
      iceConnectionState = ice;
      peer.dispatchEvent(new Event("connectionstatechange"));
    },
  };
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
          browserActivation: "required",
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
    expect(session.startupFenceSequence).toBe(0);
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

  test("exposes oai-events synchronously before any asynchronous negotiation work", async () => {
    const fixture = browserFixture();
    let resolveMedia!: (media: MediaStream) => void;
    const pendingMedia = new Promise<MediaStream>((resolve) => {
      resolveMedia = resolve;
    });
    const pending = startCodexRealtimeWebrtc({
      ...lifecycleProof,
      createPeerConnection: () => fixture.peer,
      getUserMedia: async () => await pendingMedia,
      onEventsCreated: (events) => {
        expect(events).toBe(fixture.events);
        expect(fixture.calls).toEqual(["data:oai-events"]);
        fixture.calls.push("events.created");
      },
      negotiate: async () => negotiated,
    });

    expect(fixture.calls).toEqual(["data:oai-events", "events.created"]);
    resolveMedia(fixture.media);
    const session = await pending;
    expect(fixture.calls).toEqual([
      "data:oai-events",
      "events.created",
      "addTrack",
      "createOffer",
      "setLocalDescription",
      "setRemoteDescription:answer",
    ]);
    session.stop();
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

  test("borrows caller-owned microphone media across connection rotation", async () => {
    const fixture = browserFixture();
    const session = await startCodexRealtimeWebrtc({
      ...lifecycleProof,
      media: fixture.media,
      createPeerConnection: () => fixture.peer,
      getUserMedia: async () => {
        throw new Error("borrowed media must skip getUserMedia");
      },
      negotiate: async () => negotiated,
    });
    session.stop();
    expect(fixture.calls).toContain("events.close");
    expect(fixture.calls).toContain("peer.close");
    expect(fixture.calls).not.toContain("track.stop");
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

  for (const [name, code] of [
    ["NotAllowedError", "permission_denied"],
    ["NotFoundError", "device_not_found"],
    ["NotReadableError", "device_unavailable"],
    ["UnknownError", "acquisition_failed"],
  ] as const) {
    test(`maps ${name} microphone acquisition failures without browser details`, async () => {
      const fixture = browserFixture();
      let negotiationCalls = 0;
      try {
        await startCodexRealtimeWebrtc({
          ...lifecycleProof,
          createPeerConnection: () => fixture.peer,
          getUserMedia: async () => {
            throw new DOMException("untrusted browser detail", name);
          },
          negotiate: async () => {
            negotiationCalls += 1;
            return negotiated;
          },
        });
        throw new Error("Expected microphone acquisition to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(CodexRealtimeMicrophoneError);
        expect((error as CodexRealtimeMicrophoneError).code).toBe(code);
        expect((error as Error).message).not.toContain("untrusted browser detail");
      }
      expect(negotiationCalls).toBe(0);
      expect(fixture.calls).toEqual(expect.arrayContaining(["events.close", "peer.close"]));
    });
  }

  test("reports an ended borrowed microphone and never negotiates it", async () => {
    const fixture = browserFixture();
    fixture.endMicrophone();
    let negotiationCalls = 0;
    await expect(
      startCodexRealtimeWebrtc({
        ...lifecycleProof,
        media: fixture.media,
        createPeerConnection: () => fixture.peer,
        negotiate: async () => {
          negotiationCalls += 1;
          return negotiated;
        },
      }),
    ).rejects.toMatchObject({ code: "track_ended" });
    expect(negotiationCalls).toBe(0);
    expect(fixture.calls).not.toContain("track.stop");
  });

  test("keeps microphone input enabled during remote playback and retries blocked autoplay", async () => {
    const fixture = browserFixture();
    fixture.rejectNextPlay();
    const audibleStates: string[] = [];
    let microphoneEnded = 0;
    let negotiationCalls = 0;
    const session = await startCodexRealtimeWebrtc({
      ...lifecycleProof,
      media: fixture.media,
      remoteAudio: fixture.remoteAudio,
      createPeerConnection: () => fixture.peer,
      onAudibleOutputState: (state) => audibleStates.push(state),
      onMicrophoneEnded: () => {
        microphoneEnded += 1;
      },
      negotiate: async () => {
        negotiationCalls += 1;
        return negotiated;
      },
    });
    fixture.dispatchRemoteTrack();
    await Promise.resolve();
    await Promise.resolve();
    expect(audibleStates).toEqual(["pending", "blocked"]);
    expect(fixture.track.enabled).toBe(true);
    expect(session.microphoneHealthy()).toBe(true);
    fixture.allowPlay();
    expect(await session.retryAudibleOutput()).toBe(true);
    expect(audibleStates).toEqual(["pending", "blocked", "pending", "audible"]);
    expect(negotiationCalls).toBe(1);
    expect(fixture.remoteAudio.srcObject).toBe(fixture.remoteMedia);

    fixture.endMicrophone();
    expect(microphoneEnded).toBe(1);
    expect(session.microphoneHealthy()).toBe(false);
    session.stop();
    fixture.endMicrophone();
    fixture.setConnectionState("failed");
    expect(microphoneEnded).toBe(1);
    expect(fixture.remoteAudio.srcObject).toBeNull();
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
