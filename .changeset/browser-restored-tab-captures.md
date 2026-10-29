---
"@opengeni/browserd": patch
---

A screenshot of a tab that has not drawn yet, such as one a relaunched browser has just restored, used to fail as an internal error, because Chrome refuses to capture such a tab instead of waiting. It now waits for the tab to draw, and if the tab never draws it fails as a plain, retryable screenshot timeout.
