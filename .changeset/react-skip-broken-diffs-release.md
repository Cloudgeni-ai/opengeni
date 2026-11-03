---
"@opengeni/react": patch
---

The `@pierre/diffs` peer range skips 1.6.3. That release was published with unresolved `workspace:*` and `catalog:` dependencies, so a fresh install of `@opengeni/react` that picked it failed. Installs now resolve to 1.6.2 or a later fixed release.
