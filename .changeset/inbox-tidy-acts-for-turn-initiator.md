---
"@opengeni/api-router": patch
---

`inbox_tidy` now acts for the person whose message started the calling turn, as `notify_user` and `call_user` already do: their inbox, their tidy policy, and only their items to list, snooze or dismiss. Before, it always used the session owner's inbox, so another member's turn in a shared chat could reach it. A turn with no person behind it gets the existing empty result.
