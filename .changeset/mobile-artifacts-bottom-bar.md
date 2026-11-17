---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Artifacts in the phone app. A bottom bar moves between Chats, Artifacts, Meetings and Inbox (with a count of what waits on you; Automations stays in the chats menu), and a swipe right from the left edge opens the chats menu. Artifacts lists the workspace's Sites, documents, presentations, spreadsheets, images and files as cards with a still, with search and type chips; a card opens a full-screen viewer with Share and the web library's menu (Open chat, Pin, Duplicate, Copy link, Download, Delete…). An artifact linked on its own line in a chat is a card that opens the same viewer.

`createWebMarkdownRenderer` takes `renderOpenGeniLink` to draw a standalone Opengeni object link as a block. The native icon set adds `presentation`, `share` and `link`. `SiteViewRoute` takes `embedded` to show the Site alone, without its toolbar or chat. The inbox row's snooze fade no longer crashes dev builds with a non-increasing range, and `useNativeInbox` starts empty when its client changes (another account) instead of showing the last account's items.
