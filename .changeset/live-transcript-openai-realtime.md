---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react-native": patch
"@opengeni/core": minor
"@opengeni/config": minor
---

The live transcript preview can stream to gpt-4o-transcribe and gpt-4o-mini-transcribe on OpenAI or Azure OpenAI, so a deployment that keeps audio in one region (for example Azure in the EU) can offer it. `OPENGENI_RECORDING_LIVE_TRANSCRIPTION` (`provider/model`) names the deployment's live model; with `OPENGENI_SPEECH_TO_TEXT_PINNED`, the preview goes only to the pinned provider or this model, while meetings and dictation stay on the pin. Live sessions use the new `openai.realtime` protocol: the grant carries a short-lived client secret (`token`) and a `webrtcUrl`. A browser recorder sends a copy of each track over WebRTC, muted while paused and after Stop; React Native streams PCM over a WebSocket signed in with a header. `createLiveTranscriber` takes `mediaTrack`, `RTCPeerConnection`, `fetch`, `now` and `webSocketHeaders`, and the transcriber has `setPaused`. Audio held while connecting is resampled when the session's rate differs. The Azure OpenAI voice input provider can sign in with the deployment's own Microsoft Entra identity when its endpoint or deployment is named for voice input and it has no key.
