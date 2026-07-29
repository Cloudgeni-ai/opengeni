import type {
  CodexRealtimeVoice,
  CodexRealtimeWebrtcRequest,
  CodexRealtimeWebrtcResponse,
} from "./types";

export type CodexRealtimeNegotiator = (
  request: CodexRealtimeWebrtcRequest,
  options: { signal?: AbortSignal | undefined },
) => Promise<CodexRealtimeWebrtcResponse>;

export type CodexRealtimeMicrophoneErrorCode =
  | "permission_denied"
  | "device_not_found"
  | "device_unavailable"
  | "track_ended"
  | "acquisition_failed";

export class CodexRealtimeMicrophoneError extends Error {
  constructor(
    readonly code: CodexRealtimeMicrophoneErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodexRealtimeMicrophoneError";
  }
}

export type CodexRealtimeAudibleOutputState = "inactive" | "pending" | "audible" | "blocked";

export type CodexRealtimeConnectionHealth = "connected" | "disconnected" | "failed" | "closed";

export type AcquireCodexRealtimeMicrophoneOptions = {
  signal?: AbortSignal | undefined;
  getUserMedia?: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | undefined;
};

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
  /** Replacement transports defer taking over the shared audio element until promotion. */
  activateRemoteAudio?: boolean | undefined;
  onAudibleOutputState?: ((state: CodexRealtimeAudibleOutputState) => void) | undefined;
  onMicrophoneEnded?: (() => void) | undefined;
  onConnectionHealth?: ((health: CodexRealtimeConnectionHealth) => void) | undefined;
};

export type CodexRealtimeWebrtcSession = {
  readonly peerConnection: RTCPeerConnection;
  readonly events: RTCDataChannel;
  readonly media: MediaStream;
  readonly operationId: string;
  readonly connectionId: string;
  readonly connectionEpoch: number;
  readonly startupFenceSequence: number;
  readonly modeVersion: number;
  microphoneHealthy(): boolean;
  audibleOutputState(): CodexRealtimeAudibleOutputState;
  activateRemoteAudio(): void;
  retryAudibleOutput(): Promise<boolean>;
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
  let remoteStream: MediaStream | null = null;
  let remoteAudioActive = options.activateRemoteAudio ?? true;
  let audibleOutput: CodexRealtimeAudibleOutputState = "inactive";
  let audioAttempt = 0;

  const publishAudibleOutput = (next: CodexRealtimeAudibleOutputState): void => {
    if (stopped && next !== "inactive") return;
    audibleOutput = next;
    options.onAudibleOutputState?.(next);
  };

  const playRemoteAudio = async (): Promise<boolean> => {
    const remoteAudio = options.remoteAudio;
    const stream = remoteStream;
    if (stopped || !remoteAudioActive || !remoteAudio || !stream) return false;
    remoteAudio.autoplay = true;
    remoteAudio.srcObject = stream;
    const attempt = ++audioAttempt;
    publishAudibleOutput("pending");
    try {
      await remoteAudio.play();
      if (stopped || attempt !== audioAttempt || remoteAudio.srcObject !== stream) return false;
      publishAudibleOutput("audible");
      return true;
    } catch {
      if (!stopped && attempt === audioAttempt && remoteAudio.srcObject === stream) {
        publishAudibleOutput("blocked");
      }
      return false;
    }
  };

  const onRemoteTrack = (event: RTCTrackEvent): void => {
    if (stopped || event.track.kind !== "audio") return;
    const stream = event.streams[0];
    if (!stream) return;
    remoteStream = stream;
    if (remoteAudioActive) void playRemoteAudio();
  };
  if (options.remoteAudio) peerConnection.addEventListener("track", onRemoteTrack);
  const onConnectionState = (): void => {
    if (stopped) return;
    const peerState = peerConnection.connectionState;
    const iceState = peerConnection.iceConnectionState;
    if (peerState === "failed" || iceState === "failed") {
      options.onConnectionHealth?.("failed");
    } else if (peerState === "disconnected" || iceState === "disconnected") {
      options.onConnectionHealth?.("disconnected");
    } else if (peerState === "closed" || iceState === "closed") {
      options.onConnectionHealth?.("closed");
    } else if (peerState === "connected" || iceState === "connected" || iceState === "completed") {
      options.onConnectionHealth?.("connected");
    }
  };
  const onChannelClose = (): void => {
    if (!stopped) options.onConnectionHealth?.("closed");
  };
  const onChannelError = (): void => {
    if (!stopped) options.onConnectionHealth?.("failed");
  };
  peerConnection.addEventListener("connectionstatechange", onConnectionState);
  peerConnection.addEventListener("iceconnectionstatechange", onConnectionState);
  events.addEventListener("close", onChannelClose);
  events.addEventListener("error", onChannelError);
  let audioTracks: MediaStreamTrack[] = [];
  const onMicrophoneEnded = (): void => {
    if (!stopped) options.onMicrophoneEnded?.();
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    audioAttempt += 1;
    options.signal?.removeEventListener("abort", stop);
    if (options.remoteAudio) peerConnection.removeEventListener("track", onRemoteTrack);
    peerConnection.removeEventListener("connectionstatechange", onConnectionState);
    peerConnection.removeEventListener("iceconnectionstatechange", onConnectionState);
    events.removeEventListener("close", onChannelClose);
    events.removeEventListener("error", onChannelError);
    for (const track of audioTracks) track.removeEventListener?.("ended", onMicrophoneEnded);
    try {
      events.close();
    } finally {
      try {
        if (ownsMedia) media?.getTracks().forEach((track) => track.stop());
      } finally {
        if (options.remoteAudio && options.remoteAudio.srcObject === remoteStream) {
          options.remoteAudio.pause();
          options.remoteAudio.srcObject = null;
        }
        remoteStream = null;
        publishAudibleOutput("inactive");
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
      media = await acquireCodexRealtimeMicrophone({
        getUserMedia,
        signal: options.signal,
      });
      ownsMedia = true;
    }
    throwIfAborted(options.signal);
    audioTracks = media.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new CodexRealtimeMicrophoneError(
        "device_not_found",
        "No microphone audio track is available",
      );
    }
    if (!microphoneTracksHealthy(audioTracks)) {
      throw new CodexRealtimeMicrophoneError(
        "track_ended",
        "The microphone audio track is no longer available",
      );
    }
    for (const track of audioTracks) {
      track.addEventListener?.("ended", onMicrophoneEnded);
      peerConnection.addTrack(track, media);
    }

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
        browserActivation: "required",
        sdp: localSdp,
        version: "v3",
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
        ...(options.voice === undefined ? {} : { voice: options.voice }),
      },
      { signal: options.signal },
    );
    throwIfAborted(options.signal);
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
      operationId: options.operationId,
      connectionId: answer.connectionId,
      connectionEpoch: answer.connectionEpoch,
      startupFenceSequence: answer.startupFenceSequence,
      modeVersion: answer.modeVersion,
      microphoneHealthy: () => microphoneTracksHealthy(audioTracks),
      audibleOutputState: () => audibleOutput,
      activateRemoteAudio: () => {
        if (stopped || remoteAudioActive) return;
        remoteAudioActive = true;
        if (remoteStream) void playRemoteAudio();
      },
      retryAudibleOutput: playRemoteAudio,
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}

export async function acquireCodexRealtimeMicrophone(
  options: AcquireCodexRealtimeMicrophoneOptions = {},
): Promise<MediaStream> {
  const getUserMedia = options.getUserMedia ?? defaultGetUserMedia;
  let media: MediaStream;
  try {
    media = await abortableMedia(getUserMedia({ audio: true }), options.signal);
  } catch (error) {
    throw microphoneAcquisitionError(error, options.signal);
  }
  const tracks = media.getAudioTracks();
  if (tracks.length === 0) {
    media.getTracks().forEach((track) => track.stop());
    throw new CodexRealtimeMicrophoneError(
      "device_not_found",
      "No microphone audio track is available",
    );
  }
  if (!microphoneTracksHealthy(tracks)) {
    media.getTracks().forEach((track) => track.stop());
    throw new CodexRealtimeMicrophoneError(
      "track_ended",
      "The microphone audio track is no longer available",
    );
  }
  return media;
}

export function codexRealtimeMicrophoneHealthy(media: MediaStream | null): boolean {
  return media !== null && microphoneTracksHealthy(media.getAudioTracks());
}

function microphoneTracksHealthy(tracks: readonly MediaStreamTrack[]): boolean {
  return tracks.length > 0 && tracks.every((track) => track.readyState !== "ended");
}

function microphoneAcquisitionError(error: unknown, signal: AbortSignal | undefined): Error {
  if (signal?.aborted) {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new CodexRealtimeMicrophoneError(
      "permission_denied",
      "Microphone permission was denied",
    );
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return new CodexRealtimeMicrophoneError("device_not_found", "No microphone device was found");
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return new CodexRealtimeMicrophoneError(
      "device_unavailable",
      "The microphone device is unavailable",
    );
  }
  return new CodexRealtimeMicrophoneError(
    "acquisition_failed",
    "Microphone capture could not be started",
  );
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
