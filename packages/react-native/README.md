# @opengeni/react-native

Opengeni agents in a React Native or Expo app: the session timeline and composer adapters, voice dictation, and realtime voice calls with your agent. Everything runs on the same `@opengeni/sdk` and `@opengeni/react` controllers as the web, so behavior matches the web app.

```sh
npx expo install @opengeni/react-native @opengeni/react @opengeni/sdk
```

## Session surfaces

Wrap the app in `OpenGeniReactNativeProvider` with adapters (ready-made Expo ones come from `@opengeni/react-native/expo`), then drive a session with `useOpenGeniNativeSession` and render it with the components in `@opengeni/react-native/timeline`.

```tsx
import { OpenGeniReactNativeProvider } from "@opengeni/react-native";
import { createExpoOpenGeniAdapters } from "@opengeni/react-native/expo";

<OpenGeniReactNativeProvider adapters={createExpoOpenGeniAdapters({ persistence })}>
  {children}
</OpenGeniReactNativeProvider>;
```

## Voice calls with your agent

A call is the web's realtime voice session on native WebRTC, reported to the system as a phone call (CallKit on iOS). It keeps working with the phone locked, follows AirPods and CarPlay, shows in the Phone app's recents, and ends from the lock screen or a headset.

```sh
npx expo install react-native-webrtc
```

```tsx
import {
  OpenGeniNativeCallView,
  useNativeRealtimeCall,
  useNativeSessionRealtime,
} from "@opengeni/react-native";
import { createExpoCallAdapter } from "@opengeni/react-native/expo";
import {
  connectCallAudioToWebRtc,
  createReactNativeWebRtcAdapter,
} from "@opengeni/react-native/webrtc";

const webrtc = createReactNativeWebRtcAdapter();

function AgentCall({ session }: { session: SessionInputs }) {
  const call = useMemo(() => createExpoCallAdapter(), []);
  useEffect(() => (call ? connectCallAudioToWebRtc(call) : undefined), [call]);
  // The same inputs the web's useSessionRealtime takes, plus native WebRTC.
  const realtime = useNativeSessionRealtime({ ...session, webrtc });
  const agentCall = useNativeRealtimeCall({ realtime, call, title: session.title });
  return <OpenGeniNativeCallView call={agentCall} title={session.title} />;
}
```

- `useNativeSessionRealtime` takes the same session inputs as `useSessionRealtime` from `@opengeni/react/session-realtime` (client, workspace, session, status, control, events). Pick the voice model with `useRealtimeModelSelection`. Native voice supports the WebRTC models; check with `nativeRealtimeModelSupported`.
- `useNativeRealtimeCall` starts and ends the system call with the voice session and mirrors mute both ways. Without a call adapter (for example on Android), voice still works without a system call.
- Calls started outside the app (Siri, Phone recents, a home-screen quick action whose type ends in `.call`) arrive as `startRequested` events, or through `takePendingStartRequest()` after a cold launch. The host decides which session they talk to.

### iOS configuration

Expo autolinking picks up this package's call module. Add to the app config:

```json
{
  "ios": {
    "infoPlist": {
      "UIBackgroundModes": ["audio", "voip"],
      "NSUserActivityTypes": ["INStartCallIntent"],
      "NSMicrophoneUsageDescription": "Talk to your agent on voice calls."
    }
  }
}
```

CallKit refuses call requests from an app without the `voip` background mode, so without it the call still talks but never appears as a system call (lock screen, Dynamic Island, Phone recents, headset controls).

In a monorepo where this package is linked rather than installed, add its folder to `expo.autolinking.searchPaths` in the app's `package.json`.
