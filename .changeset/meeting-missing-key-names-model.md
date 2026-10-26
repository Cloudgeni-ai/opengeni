---
"@opengeni/react": minor
"@opengeni/react-native": patch
---

A transcript that failed because its model's provider has no key now names the model and that provider ("Scribe v2 needs ElevenLabs, which isn't connected…"), on the web and on phones, instead of saying that no transcription provider is connected. It suggests trying another model only when the deployment offers more than one, and for a provider the deployment itself pays for it points to whoever runs the deployment rather than to Organization settings. `transcriptErrorText` takes an optional third argument with the model's and provider's names, and optionally its `funding` and whether the deployment is `pinned`.
