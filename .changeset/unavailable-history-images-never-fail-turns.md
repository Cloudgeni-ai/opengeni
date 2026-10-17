---
"@opengeni/worker-bundle": patch
---

A chat whose history refers to an image that was never stored (for example because the workspace image storage was full) or is no longer available (expired, deleted, missing or corrupt) keeps working. The model sees short, fixed text in place of that image instead of every turn failing with "Retained screenshot ... is unavailable".
