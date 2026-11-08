---
"@opengeni/react": minor
"@opengeni/react-native": minor
---

Chat and agent avatars now show in native apps as they do on the web. `@opengeni/react-native/timeline` adds `SessionAvatar` (emoji, letters, icon or image avatars on their hue; image avatars load with the person's own access and fall back to the chat's initials) and `useNativeSessionIdentity`. Session rows show a chat's avatar beside its title when given an `avatarClient`, and `SessionHeaderTitle` takes `avatar` and `agentName`, so an agent's chat shows the agent's current icon and name. The shared rules (initials, fallback colours, tile colours, the agent behind a chat) are in the new `@opengeni/react/session-avatar-model` entry point.
