---
"@opengeni/contracts": minor
---

Usage reads (`getUsage`, `getMyUsage`) now return `unit: "usd_micros"`, naming the unit of every amount, and their `period` is the window the counters cover even when no budget is configured (the current calendar month in UTC), instead of `{ start: null, end: null }`. In a chat, app actions in one workspace run in the chat's own workspace when the call leaves out `workspaceId`; search and describe results name it under `pathParameterDefaults`. The action catalog now records the permission usage, allowance and insights routes check first, so a person who can't run them is no longer offered them.
