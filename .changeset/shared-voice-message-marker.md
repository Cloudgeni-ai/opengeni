---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

A message spoken in a realtime voice call now shows "Voice request" (or "Voice handoff" when a call ends) with the audio icon in the shared web and React Native timelines, with the context the call sent behind a closed "Context sent to agent" disclosure. Before, only the Opengeni web app drew it, so products embedding `MessageTimeline` showed spoken messages as if they were typed. The marker sits outside the message text, so a custom `renderMessageText` keeps it. The new `messageTimeline.voiceContextSent` key translates the disclosure label.
