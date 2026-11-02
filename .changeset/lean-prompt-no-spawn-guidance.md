---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Sessions that cannot create child sessions (their nesting depth has reached its maximum) no longer receive delegation and child-integration guidance in their instructions, about 470 fewer prompt tokens on every model call. The bundled projects Skill is listed only when the session has the project tools.
