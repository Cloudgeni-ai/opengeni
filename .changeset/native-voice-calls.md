---
"@opengeni/react-native": minor
---

`@opengeni/react-native` is now published to npm. It adds realtime voice calls with your agent:

- `useNativeSessionRealtime` runs the web's `useSessionRealtime` (same SDK controller, admission rules and lifecycle recovery) on native WebRTC.
- `useNativeRealtimeCall` keeps a system call (CallKit on iOS) and the voice session in lockstep, mirroring hang-up and mute both ways.
- `OpenGeniNativeCallView` is a full-screen call screen in the web theme.
- `createExpoCallAdapter` (from `./expo`) uses the package's own Expo module, which autolinking picks up: CallKit calls listed in Recents, an audio session that keeps working with the phone locked and follows AirPods, and start requests from Siri, the Phone app and a home-screen action.
- The opt-in `./webrtc` entry wires `react-native-webrtc` (an optional peer) to the voice controller and the call audio session.
