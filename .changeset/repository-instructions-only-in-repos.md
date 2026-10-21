---
"@opengeni/runtime": patch
---

Sandbox agents look for AGENTS.md repository instructions only in a code repository, so a task in a workspace with no repository no longer spends its first step scanning for them.
