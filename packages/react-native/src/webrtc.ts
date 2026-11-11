// @opengeni/react-native/webrtc: the ready-made native WebRTC adapter.
//
// A separate entry point so hosts without voice never load the native WebRTC
// module. Requires the optional peer dependency `react-native-webrtc`.
import { mediaDevices, RTCAudioSession, RTCPeerConnection } from "react-native-webrtc";
import type { NativeCallAdapter } from "./realtime/native-call";
import type { NativeWebRtcAdapter } from "./realtime/native-realtime";

export function createReactNativeWebRtcAdapter(
  configuration: RTCConfiguration = {},
): NativeWebRtcAdapter {
  return {
    createPeerConnection: () =>
      new RTCPeerConnection(configuration as never) as unknown as globalThis.RTCPeerConnection,
    getUserMedia: async (constraints) =>
      (await mediaDevices.getUserMedia(constraints as never)) as unknown as MediaStream,
  };
}

/**
 * Hand the system call's audio session to WebRTC: CallKit activates it (so
 * audio keeps running with the phone locked and follows AirPods or CarPlay),
 * and WebRTC starts and stops its voice-processing audio on those signals.
 */
export function connectCallAudioToWebRtc(call: NativeCallAdapter): () => void {
  return call.subscribe((event) => {
    if (event.type === "audioSessionActivated") RTCAudioSession.audioSessionDidActivate();
    else if (event.type === "audioSessionDeactivated") RTCAudioSession.audioSessionDidDeactivate();
  });
}
