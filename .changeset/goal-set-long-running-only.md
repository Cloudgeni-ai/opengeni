---
"@opengeni/api-router": patch
---

The `goal_set` tool description now says goals are for long-running objectives that need several turns or continued autonomous work, and that a short or single-step request is answered directly. It used to open with "Create a goal when this session has none", which agents read as an instruction to wrap every request in a goal, adding a goal_set and a goal_complete round trip to one-step tasks.
