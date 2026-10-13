---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
---

Scheduled task reads now include `accountPlan` for a viewer who can act on the task: for each connector, whether it follows the owner's current accounts (`default`) or uses accounts a person pinned (`pinned`), which accounts a run would use if it started now, and any pinned account that can no longer be used. It is resolved at read time from the owner's live connections and never stored.

The schedule page shows this as an Accounts section, and a pin that can no longer be used can go back to the owner's current accounts in one step.
