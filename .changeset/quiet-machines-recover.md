---
"@opengeni/events": patch
"@opengeni/runtime": patch
---

Recover pending Connected Machine requests immediately when the machine's control transport reconnects, preserving exact delivery identity and operation deadlines instead of waiting for a lost reply to time out.
