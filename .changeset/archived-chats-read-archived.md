---
"@opengeni/react": minor
"@opengeni/react-native": minor
"@opengeni/contracts": minor
"@opengeni/core": patch
---

Archived chats now read as Archived everywhere, never as "Cancelled". Archiving a chat stops its running work, which leaves the session's internal status `cancelled`; the chat header, sidebar row and hover card, session tiles, sub-agent list, inspector, conversation divider, empty state and composer placeholder (web and native) now show the archive instead, with the existing read-only notice and Continue in a new chat. `sessionDisplayStatus` returns the new `archived` display status for archived sessions, and `sessionArchived` and `sessionStatusItemDisplayStatus` are exported. The packaged conversation is read-only for archived chats too, and `session_get` reports the archive as soon as a chat is archived, before its content is stored.
