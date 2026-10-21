---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/react": patch
---

Organizations can set up realtime voice once for every workspace. An organization ElevenLabs key (`elevenlabs` organization provider connection) is used by every workspace without its own key, and organization model defaults gain `realtimeVoice`: per-model voice, language and turn-taking defaults that a workspace uses for a model until it saves its own. The realtime model catalog reports the inherited settings as `organizationVoiceSettings`. Organization custom models stay limited to the model-catalog provider kinds (`OrganizationModelCatalogProviderKind`).
