---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

On Claude Opus 5.5 and Sonnet 5.5, a progress update is no longer shown or recorded as the agent's message or reply. Claude returns only a summary of it, which could claim things the agent never wrote. It now shows as a thought, and when a person's turn has no real reply before `wait_for_input`, the agent is asked to write one instead of the summary being used.
