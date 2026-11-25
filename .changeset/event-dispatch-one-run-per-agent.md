---
"@opengeni/react": patch
---

Automation run history explains the `duplicate_agent_run` skip: one event delivery starts at most one run per agent, so when several automations of the same agent match it, the others record a skipped run with that reason.
