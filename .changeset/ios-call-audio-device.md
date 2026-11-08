---
"@opengeni/react-native": minor
---

An optional iOS call audio device for WebRTC (config plugin option `call.iosAudioDevice`), so a call can connect while the phone rings without opening the microphone. With it, WebRTC's audio runs through Opengeni's device instead of its built-in one: while a CallKit call rings it sends silent audio frames and drops whatever the far end plays, so the connection is live and the far end hears a silent line; once CallKit activates the audio session on answer (at once for a call placed in the app, or without CallKit) it runs Apple's voice-processing I/O unit, as WebRTC's own device does, so echo cancellation, noise suppression and gain control are unchanged. It falls back to silence and recovers through audio interruptions, rebuilds itself after a media-services reset or a route change that alters the sample rate, and leaves loudspeaker toggles alone. Off by default; it needs react-native-webrtc.
