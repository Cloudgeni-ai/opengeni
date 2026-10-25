---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

A chat's "waiting on" status names every app its automations wait on, not only the first. `SessionAutomationWaitSummary` gains `events`: one entry per source with all the event types its active triggers wait for, in the order the automations were made. The header chip reads "Waiting on GitHub and Gmail" (two names, then "and 2 more"), and its tooltip, the sidebar mark and the hover card list each source's events. With servers that only send `event`, the words are as before.
