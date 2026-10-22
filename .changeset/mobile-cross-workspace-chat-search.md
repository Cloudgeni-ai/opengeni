---
"@opengeni/react": minor
"@opengeni/react-native": minor
---

The mobile app can search chats across all of a person's workspaces, like ⌘K on the web. A search button on the home screen opens the chat search, which matches chat titles in the current workspace first and in the person's other workspaces after, labelling each chat from another workspace with its workspace's name. Matching workspaces appear too, so a search can also switch workspace. Opening a chat from another workspace switches to that workspace. `SessionRow` accepts an optional `workspaceName`, and `@opengeni/react` exports the chat-title ranking helpers `rankLabel`, `foldForSearch` and `LOOSE_MATCH_BELOW`.
