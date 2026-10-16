---
"@opengeni/contracts": patch
---

Scheduled runs now tell the agent what to do when something blocks the task: try to fix it, otherwise notify the schedule's owner once under the schedule's notice key, and pause the schedule when no later run can succeed. Only occurrences delivered after this change carry the new sentence.
