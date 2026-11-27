---
"@opengeni/react-native": minor
---

`NativeAgentCallProvider` takes `beforeCall`, and `MeetingRecorderProvider` takes `beforeCapture`: each is awaited before a call, a recording or an audio import starts, and false starts nothing (an import then fails with an `AudioImportError` whose reason is `declined`, which `showAudioImportError` doesn't show). Apps use them to ask for the person's permission first, such as sharing with AI providers.
