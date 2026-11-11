import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";
import {
  parseNativeCallEvent,
  parseNativeIncomingCall,
  type RawNativeCallEvent,
} from "./call-events";
import type { NativeCallAdapter } from "./native-call";

type OpenGeniCallNativeModule = {
  configure(includeInRecents: boolean): void;
  startCall(callId: string, title: string, target: string | null): Promise<void>;
  reportConnected(callId: string): void;
  endCall(callId: string, failed: boolean): Promise<void>;
  setMuted(callId: string, muted: boolean): Promise<void>;
  setSpeaker(on: boolean): Promise<void>;
  takePendingStartRequest(): Promise<{ target: string | null } | null>;
  /**
   * Android: whether calls are system calls and agents can ring (absent
   * before them), and whether a ring may show full screen now (absent before
   * that check).
   */
  capabilities?(): { systemCall: boolean; incoming: boolean; fullScreenRing?: boolean };
  /** Android: open the setting that lets rings show full screen (absent before it). */
  openFullScreenRingSettings?(): Promise<boolean>;
  // Agent calls (absent in builds before them).
  getVoipToken?(): Promise<string | null>;
  takeIncomingCalls?(): Promise<RawNativeCallEvent[]>;
  endIncomingCall?(callId: string, reason: string): void;
  // Absent in builds before the call audio device.
  connectsBeforeAnswer?(): boolean;
  addListener(
    eventName: "onCallEvent",
    listener: (event: RawNativeCallEvent) => void,
  ): { remove(): void };
};

export { parseNativeCallEvent };

/**
 * Calls for Expo hosts, from the native module this package ships (linked by
 * Expo autolinking). On iOS a call is a CallKit call. On Android it is a
 * system call (Telecom, with a call notification) where the app turned that
 * on with the config plugin's `call.androidSystemCall`, and agents' calls ring
 * the phone when it also has push (expo-notifications, or the app's own
 * messaging service with `call.androidMessagingService: "app"`); otherwise it
 * sets up the phone's call
 * audio (communication mode, audio focus, loudspeaker or headset) without a
 * system call. Returns null where it is unavailable (web, or a build without
 * the module), so voice still works without it.
 */
export function createExpoCallAdapter(
  options: { includeInRecents?: boolean } = {},
): NativeCallAdapter | null {
  const native = requireOptionalNativeModule<OpenGeniCallNativeModule>("OpenGeniCall");
  if (!native) return null;
  native.configure(options.includeInRecents ?? true);
  const ios = Platform.OS === "ios";
  const capabilities = ios ? null : (native.capabilities?.() ?? null);
  const canRing = ios || capabilities?.incoming === true;
  // Android 14 and later may need the person to allow full-screen rings; a
  // build before the check, or iOS (CallKit), always rings full screen.
  const fullScreenCheck =
    !ios && typeof capabilities?.fullScreenRing === "boolean" && native.openFullScreenRingSettings
      ? {
          canRingFullScreen: () => {
            try {
              return native.capabilities?.().fullScreenRing !== false;
            } catch {
              return true;
            }
          },
          openFullScreenRingSettings: () => native.openFullScreenRingSettings!(),
        }
      : {};
  // Call ids are UUIDs; CallKit reports them upper-case, the hook compares lower-case.
  const id = (callId: string) => callId.toLowerCase();
  return {
    showsSystemCall: ios || capabilities?.systemCall === true,
    startCall: ({ callId, title, target }) => native.startCall(id(callId), title, target),
    reportConnected: (callId) => native.reportConnected(id(callId)),
    endCall: (callId, reason = "ended") => native.endCall(id(callId), reason === "failed"),
    setMuted: (callId, muted) => native.setMuted(id(callId), muted),
    setSpeaker: (on) => native.setSpeaker(on),
    takePendingStartRequest: () => native.takePendingStartRequest(),
    incoming:
      canRing && native.getVoipToken && native.takeIncomingCalls && native.endIncomingCall
        ? {
            getVoipToken: () => native.getVoipToken!(),
            takeIncomingCalls: async () =>
              (await native.takeIncomingCalls!()).flatMap((raw) => {
                const call = parseNativeIncomingCall(raw);
                return call ? [call] : [];
              }),
            endIncomingCall: (callId, reason) => native.endIncomingCall!(id(callId), reason),
            connectsBeforeAnswer: native.connectsBeforeAnswer?.() === true,
            ...fullScreenCheck,
          }
        : undefined,
    subscribe(listener) {
      const subscription = native.addListener("onCallEvent", (raw) => {
        const event = parseNativeCallEvent(raw);
        if (event) listener(event);
      });
      return () => subscription.remove();
    },
  };
}
