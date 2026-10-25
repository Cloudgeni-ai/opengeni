---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/react": patch
---

Archiving a chat with Pause now removes the one-time waits that continue it or its sub-chats: a run-once event automation that has not run yet, and a one-time scheduled run still ahead. They go in the same transaction as the pause, so an archived chat is never woken by a "wake me when" it was waiting on, and Restore does not bring them back. Repeating automations stay, and Hide for me changes nothing. The archive confirmation says so.
