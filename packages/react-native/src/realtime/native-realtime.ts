import {
  createSessionRealtimeController,
  type CreateSessionRealtimeControllerOptions,
  type SessionRealtimeController,
  type SessionRealtimeOwnerStorage,
} from "@opengeni/sdk/realtime";
import type { SessionRealtimeControllerFactory } from "@opengeni/react/session-realtime";

/**
 * The WebRTC entry points a native host supplies, in the shape of
 * `react-native-webrtc`. Everything else (negotiation, the realtime ledger,
 * delegation, recovery and lifecycle) stays in the shared SDK controller that
 * the web uses.
 */
export interface NativeWebRtcAdapter {
  createPeerConnection(): RTCPeerConnection;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export type NativeRealtimeControllerFactoryOptions = {
  /**
   * Owner-proof storage. Defaults to process memory, which matches the web's
   * tab-scoped session storage: a relaunched app recovers through the server
   * lifecycle rather than a stale local proof.
   */
  storage?: SessionRealtimeOwnerStorage | undefined;
};

/** Process-lifetime owner storage, the native counterpart of `sessionStorage`. */
export function createMemoryRealtimeOwnerStorage(): SessionRealtimeOwnerStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
  };
}

type AudioTrackLike = { kind?: string; enabled: boolean };
type StreamLike = { getAudioTracks?: () => AudioTrackLike[]; getTracks?: () => AudioTrackLike[] };

function audioTracks(stream: unknown): AudioTrackLike[] {
  const candidate = stream as StreamLike | null | undefined;
  if (!candidate) return [];
  if (typeof candidate.getAudioTracks === "function") return candidate.getAudioTracks();
  if (typeof candidate.getTracks === "function")
    return candidate.getTracks().filter((track) => track.kind === "audio");
  return [];
}

/**
 * Native WebRTC plays remote audio itself, through the call audio session. The
 * SDK still drives an audio element (attach, mute, play, detach), so this
 * stand-in maps those calls onto the remote audio tracks: muting disables the
 * tracks, and play resolves because playback is already live.
 */
export function createNativeRemoteAudio(): HTMLAudioElement {
  let source: unknown = null;
  let muted = false;
  let paused = true;
  const apply = () => {
    const enabled = !muted && !paused;
    for (const track of audioTracks(source)) track.enabled = enabled;
  };
  const element = {
    autoplay: true,
    get muted() {
      return muted;
    },
    set muted(value: boolean) {
      muted = Boolean(value);
      apply();
    },
    get srcObject() {
      return source;
    },
    set srcObject(value: unknown) {
      source = value ?? null;
      if (source === null) paused = true;
      apply();
    },
    get paused() {
      return paused;
    },
    async play() {
      paused = false;
      apply();
    },
    pause() {
      paused = true;
      apply();
    },
  };
  return element as unknown as HTMLAudioElement;
}

/**
 * Controller factory for `useSessionRealtime({ controllerFactory })`: the
 * shared SDK controller with native WebRTC, a native remote-audio stand-in and
 * owner storage injected. No realtime logic is forked.
 */
export function createNativeRealtimeControllerFactory(
  webrtc: NativeWebRtcAdapter,
  options: NativeRealtimeControllerFactoryOptions = {},
): SessionRealtimeControllerFactory {
  const storage = options.storage ?? createMemoryRealtimeOwnerStorage();
  return (controllerOptions: CreateSessionRealtimeControllerOptions): SessionRealtimeController =>
    createSessionRealtimeController({
      ...controllerOptions,
      storage: controllerOptions.storage ?? storage,
      remoteAudio: controllerOptions.remoteAudio ?? createNativeRemoteAudio(),
      createPeerConnection: () => webrtc.createPeerConnection(),
      getUserMedia: (constraints) => webrtc.getUserMedia(constraints),
    });
}
