---
"@opengeni/react": patch
---

The keyboard action list is built on first use (`appActions()` replaces `APP_ACTIONS`), so its icons are never read before the chunk that defines them has loaded, whichever page a visitor opens first.
