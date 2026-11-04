---
"@opengeni/agent-host": patch
---

A Connected Machine agent on Linux now comes back however often it is stopped. Its systemd unit allowed five starts a minute, so a few quick kills (a command such as `pkill -f opengeni` run in a loop, or a model retrying one) left the agent stopped until the person started it by hand. The unit now has no start limit and restarts the agent after 2 s, backing off to 30 s (systemd 254 and newer; older systemd keeps a fixed 5 s). An installed unit the agent generated is updated when the agent starts after upgrading, without restarting the agent; a unit someone edited is left alone. The macOS LaunchAgent and the Windows logon task already kept restarting the agent and are unchanged.
