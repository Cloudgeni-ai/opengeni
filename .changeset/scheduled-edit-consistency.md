---
"@opengeni/core": patch
"@opengeni/sdk": patch
---

Preserve exact account choices and newer edits when updating schedules. Reusable schedules inherit their chat's current Variable Sets, and changing to fresh chats permits new creation settings. Keep scheduler synchronization ordered against edits and deletion, and expose frozen account state in the SDK.
