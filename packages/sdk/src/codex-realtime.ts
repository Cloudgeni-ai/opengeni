import type {
  CodexRealtimeVoice,
  CodexRealtimeWebrtcRequest,
  CodexRealtimeWebrtcResponse,
} from "./types";

export type CodexRealtimeNegotiator = (
  request: CodexRealtimeWebrtcRequest,
  options: { signal?: AbortSignal | undefined },
) => Promise<CodexRealtimeWebrtcResponse>;

export type StartCodexRealtimeWebrtcOptions = {
  negotiate: CodexRealtimeNegotiator;
  realtimeId: string;
  operationId: string;
  browserInstanceId: string;
  ownerKey: string;
  expectedVersion: number;
  expectedConnectionEpoch: number;
  rotate: boolean;
  signal?: AbortSignal | undefined;
  instructions?: string | undefined;
  voice?: CodexRealtimeVoice | undefined;
  /** Injectable browser seams make complete SDP negotiation deterministic in tests. */
  createPeerConnection?: (() => RTCPeerConnection) | undefined;
  getUserMedia?: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | undefined;
  /** Reuse a caller-owned microphone across transparent connection rotations. */
  media?: MediaStream | undefined;
  /** Caller-owned audio element for the provider's remote WebRTC track. */
  remoteAudio?: HTMLAudioElement | undefined;
};

export type CodexRealtimeWebrtcSession = {
  readonly peerConnection: RTCPeerConnection;
  readonly events: RTCDataChannel;
  readonly media: MediaStream;
  readonly connectionId: string;
  readonly connectionEpoch: number;
  readonly startupFenceSequence: number;
  readonly modeVersion: number;
  /** Idempotently close media, data channel, and peer transport. */
  stop(): void;
};

/**
 * Complete the browser half of native connected-Codex GPT-Live V3 negotiation.
 * Provider credentials never enter this boundary: `negotiate` sends SDP,
 * public session configuration, and the active browser-owner proof only to the
 * OpenGeni API.
 */
export async function startCodexRealtimeWebrtc(
  options: StartCodexRealtimeWebrtcOptions,
): Promise<CodexRealtimeWebrtcSession> {
  throwIfAborted(options.signal);
  const peerConnection = (options.createPeerConnection ?? defaultPeerConnection)();
  const events = peerConnection.createDataChannel("oai-events");
  let media: MediaStream | null = null;
  let ownsMedia = false;
  let stopped = false;
  const onRemoteTrack = (event: RTCTrackEvent): void => {
    const remoteAudio = options.remoteAudio;
    if (!remoteAudio || event.track.kind !== "audio") return;
    const stream = event.streams[0];
    if (!stream) return;
    remoteAudio.autoplay = true;
    remoteAudio.srcObject = stream;
    void remoteAudio.play().catch(() => undefined);
  };
  if (options.remoteAudio) peerConnection.addEventListener("track", onRemoteTrack);
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    options.signal?.removeEventListener("abort", stop);
    if (options.remoteAudio) peerConnection.removeEventListener("track", onRemoteTrack);
    try {
      events.close();
    } finally {
      try {
        if (ownsMedia) media?.getTracks().forEach((track) => track.stop());
      } finally {
        if (options.remoteAudio) {
          options.remoteAudio.pause();
          options.remoteAudio.srcObject = null;
        }
        peerConnection.close();
      }
    }
  };
  options.signal?.addEventListener("abort", stop, { once: true });

  try {
    const getUserMedia = options.getUserMedia ?? defaultGetUserMedia;
    if (options.media) {
      media = options.media;
    } else {
      media = await abortableMedia(getUserMedia({ audio: true }), options.signal);
      ownsMedia = true;
    }
    throwIfAborted(options.signal);
    const audioTracks = media.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error("Codex realtime requires a microphone audio track");
    }
    for (const track of audioTracks) peerConnection.addTrack(track, media);

    const offer = await peerConnection.createOffer();
    if (offer.type !== "offer" || !offer.sdp) {
      throw new Error("Browser did not create a WebRTC SDP offer");
    }
    await peerConnection.setLocalDescription(offer);
    throwIfAborted(options.signal);
    const localSdp = peerConnection.localDescription?.sdp ?? offer.sdp;
    const answer = await options.negotiate(
      {
        realtimeId: options.realtimeId,
        operationId: options.operationId,
        browserInstanceId: options.browserInstanceId,
        ownerKey: options.ownerKey,
        expectedVersion: options.expectedVersion,
        expectedConnectionEpoch: options.expectedConnectionEpoch,
        rotate: options.rotate,
        sdp: localSdp,
        version: "v3",
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
        ...(options.voice === undefined ? {} : { voice: options.voice }),
      },
      { signal: options.signal },
    );
    if (answer.version !== "v3" || answer.model !== "gpt-live-1-boulder-alpha" || !answer.sdp) {
      throw new Error("OpenGeni returned an incompatible Codex realtime answer");
    }
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answer.sdp,
    });
    throwIfAborted(options.signal);
    return {
      peerConnection,
      events,
      media,
      connectionId: answer.connectionId,
      connectionEpoch: answer.connectionEpoch,
      startupFenceSequence: answer.startupFenceSequence,
      modeVersion: answer.modeVersion,
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}

function defaultPeerConnection(): RTCPeerConnection {
  if (typeof RTCPeerConnection === "undefined") {
    throw new Error("WebRTC is not available in this environment");
  }
  return new RTCPeerConnection();
}

async function defaultGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is not available in this environment");
  }
  return await navigator.mediaDevices.getUserMedia(constraints);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

async function abortableMedia(
  pending: Promise<MediaStream>,
  signal: AbortSignal | undefined,
): Promise<MediaStream> {
  if (!signal) return await pending;
  throwIfAborted(signal);
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort?.(signal.reason ?? new DOMException("Aborted", "AbortError"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  // If permission resolves after cancellation won the race, stop the newly
  // acquired tracks rather than leaking a detached microphone capture.
  void pending.then(
    (lateMedia) => {
      if (signal.aborted) lateMedia.getTracks().forEach((track) => track.stop());
    },
    () => undefined,
  );
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
