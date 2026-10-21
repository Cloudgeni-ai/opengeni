---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Realtime voice settings are configurable. Each voice model offers what its provider supports: Eleven Realtime takes its built-in voices or any voice in the ElevenLabs account's My Voices by voice ID, a conversation language and turn eagerness; AI Gateway and SuperGrok models take their built-in voices. A workspace saves settings per model in the new `realtimeVoice` workspace setting (Settings > Models > Voice, or `updateWorkspaceSettings`), and an embedding app can set them per session with `voiceSettings` on the stock voice control, `useSessionRealtime` and `prestartSessionRealtime`, or `getVoiceSettings` on SDK realtime controllers. The realtime model catalog lists each model's `voices`, `customVoice`, `turnEagerness` and `voiceDefaults` and the workspace's saved `workspaceVoiceSettings`, the WebSocket connect request takes `voiceSettings`, and the SDK exports `RealtimeVoiceSettings` and `RealtimeTurnEagerness`. Nothing changes until a setting is chosen.
