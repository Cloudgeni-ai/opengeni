---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Add Eleven Realtime voice models (v1 max and v1 mini) on the shared WebSocket voice path. Workspaces connect their own ElevenLabs API key under Settings > Models > Voice, and the voice model hands work to the Opengeni session through the same delegation tool as the other voices. The SDK exports `SESSION_REALTIME_MODELS` and `isSessionRealtimeModel`, and the WebSocket answer may set `transcriptAudioTags` so clients strip expressive audio tags from transcripts.
