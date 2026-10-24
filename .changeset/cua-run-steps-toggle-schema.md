---
"@opengeni/contracts": patch
---

Native CUA run_steps calls work again on macOS and Linux: their bundled tool definitions now include the `toggle_to` step field the pinned CUA worker publishes, so the worker's schema matches this release instead of every run_steps call being refused as a version mismatch. Windows runs the published driver, which has no such field, so its definitions are unchanged.
