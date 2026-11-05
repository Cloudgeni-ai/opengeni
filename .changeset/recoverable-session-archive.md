---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/sdk": minor
"@opengeni/worker-bundle": patch
---

Archiving a chat no longer silently stops sub-chats that are still in use, and archived chats can be restored. Archive is refused (409 `session_archive_blocked`, blockers of kind `active_sub_chat`) while a sub-chat is running, waiting for input, working on a goal or was messaged by a person in the last 14 days; the refusal names each one with how many, and repeating the request with `confirmActiveSubChats` listing them archives them too. In the web app a notice names them and offers "Archive all". `{ "archived": false }` now restores a chat at any time: within the undo window it is the exact undo, and later the chat and the sub-chats archived with it come back, with content already in long-term storage put back from the verified bundle in the background (`retention.archive.restoring` until done). Archived chats show a "Restore chat" button.
