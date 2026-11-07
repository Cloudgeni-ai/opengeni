---
"@opengeni/react-native": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Voice calls on Android now set up the phone's call audio, and a call that is silent on one side says so.

- Android: `createExpoCallAdapter` no longer returns null. The package's call module now ships an Android side that, while a call runs, takes audio focus for voice communication, switches the phone into communication mode and routes the call to a connected headset or the loudspeaker (every call starts on the loudspeaker, as on iOS), then restores the previous audio state when the call ends. Before, WebRTC recorded and played as if no call were running, and on some phones the microphone handed the call nothing but silence, so the voice never heard the person. There is no system call screen on Android: the adapter reports `showsSystemCall: false`, `systemCall` stays false, and agent calls (`incoming`) remain iOS-only. The package's Android manifest adds `MODIFY_AUDIO_SETTINGS`, a normal permission with no prompt. Native Android builds need a rebuild to include the module.
- SDK: while a call is live, the realtime controller reads the peer connection's audio statistics once a second. An unmuted microphone that delivers no sound at all for 8 seconds raises the recoverable `no_input_audio` diagnostic, and a finished reply whose audio never played raises `output_silent`; both set `error` with a plain message and clear once audio flows. Platforms whose statistics lack audio energy report nothing.
- React Native: `useNativeRealtimeCall` returns a `notice` for these, and `OpenGeniNativeCallView` shows it under the call status.
- React: the voice control shows "No sound from your microphone" or "Reply not played" beside the button, with the detail in its menu.
