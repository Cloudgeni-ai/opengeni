---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
---

A configured agent now always gets `goal_resume` and the goals sentence that names it. Before, both appeared only once the session had a goal, so a session's first goal changed the tool list and system prompt under every earlier request and the next turn re-read the whole history uncached.
