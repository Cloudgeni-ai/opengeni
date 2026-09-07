---
"@opengeni/react": patch
---

Keep an unpinned timeline reader in place when older history prepends into a compact tail. Restoring the row offset no longer looks like a scroll back to the live tip, so the view does not snap to the bottom after loading earlier messages.
