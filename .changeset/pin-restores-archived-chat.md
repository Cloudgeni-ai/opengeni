---
"@opengeni/db": patch
"@opengeni/react": patch
---

Pinning an archived chat restores it, so it shows under Pinned. A chat opened from search could be pinned from its header while archived: it was marked pinned but never appeared under Pinned, which lists active chats only. Pinning now restores the chat in the same transaction (archiving still unpins), the open chat's header reflects the restore at once, and a migration repairs chats already saved as both pinned and archived.
