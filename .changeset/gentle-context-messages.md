---
"@opengeni/contracts": major
"@opengeni/core": major
"@opengeni/db": major
"@opengeni/runtime": major
"@opengeni/sdk": major
"@opengeni/react": major
---

Replace the removed per-turn `turnInstructions` system-prefix contract with generic per-message `modelContext` content. This is a breaking release-train cutover: old mutating clients are rejected after migration 0240. Context now enters canonical user history without standard timeline rendering, preserves the persistent prompt-cache prefix, and works across initial, queued, steer, realtime delegation, and transcript handoff paths.
