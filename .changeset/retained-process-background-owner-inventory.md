---
"@opengeni/db": patch
---

The retained-process inventory (migration 0637, rolling) now classifies a process durably adopted as a session background command by that command, as the reconciliation claim already did: `background_running` is session-owned live work and never counts toward `opengeni_retained_processes_terminal_owner_backlog`, while `background_stopping` (a stop was requested but no exit/loss proof yet) still does. A server the agent leaves running after its turn no longer fires `OpenGeniRetainedProcessTerminalOwnerBacklog`.
