---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A sandbox that stays running between turns is now checkpointed at the snapshot interval when it has unsaved changes. Before, a box kept running by an open desktop or terminal tab, a browser or computer session, or a background command (a server, a build, or a command the agent was waiting on) was saved only while a turn was open, so changes could sit unsaved until the provider's 24-hour deadline. The reaper now takes the same warm Modal snapshot a turn would, around those holders, at most once per snapshot interval. Turn checkpoints also no longer skip while a desktop or terminal tab is open. A clean box, or one held by a turn, an open request or a supervised command, is left alone.
