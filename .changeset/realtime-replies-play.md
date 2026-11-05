---
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Voice replies play again when voice starts inside an open chat. The voice control hides until the voice-model catalog loads, and the hidden audio element went with it, so a call started there on a fresh page load had nothing to play its replies through: the transcript appeared but nothing was heard, and no prompt said so. The realtime controller now plays replies through its own audio element unless the host passes one (`remoteAudio` stays optional), so playback no longer depends on when a host mounts an element. `useSessionRealtime().audioRef` and `RealtimeVoiceControl`'s `audioRef` prop are kept but deprecated; rendering them has no effect.

When the browser refuses to play replies, the voice control now shows a plain "Tap to hear replies" prompt beside the voice button; tapping it plays them.
