---
"@opengeni/react": patch
---

The `@pierre/diffs` peer range skips 1.6.3, a release published with unresolved `workspace:*` dependencies that no package manager can install. Apps that install `@opengeni/react` with its peers no longer fail on it.
