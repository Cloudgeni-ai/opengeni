import { useMemo } from "react";
import { useSessionRealtime } from "@opengeni/react/session-realtime";
import {
  createNativeRealtimeControllerFactory,
  type NativeRealtimeControllerFactoryOptions,
  type NativeWebRtcAdapter,
} from "./native-realtime";

export type UseNativeSessionRealtimeOptions = Omit<
  Parameters<typeof useSessionRealtime>[0],
  "controllerFactory"
> & {
  /** Native WebRTC, for example `createReactNativeWebRtcAdapter()` from `./webrtc`. */
  webrtc: NativeWebRtcAdapter;
  storage?: NativeRealtimeControllerFactoryOptions["storage"];
};

/**
 * The web's `useSessionRealtime`, driven by native WebRTC. Same controller,
 * same admission rules, same lifecycle recovery; only media is injected.
 */
export function useNativeSessionRealtime(options: UseNativeSessionRealtimeOptions) {
  const { webrtc, storage, ...realtimeOptions } = options;
  const controllerFactory = useMemo(
    () => createNativeRealtimeControllerFactory(webrtc, storage ? { storage } : {}),
    [webrtc, storage],
  );
  return useSessionRealtime({ ...realtimeOptions, controllerFactory });
}
