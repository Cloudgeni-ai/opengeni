---
"@opengeni/runtime": patch
---

A sandbox command no tool call owns, such as a workspace capture's Git and file reads or platform setup, now releases its retained output on the machine as soon as its result returns. Before, that output stayed retained until a durability hook its caller often never reached, so the agent kept it, and an open spool file, for up to an hour. Busy compute sandboxes could then run out of file descriptors. Tool-owned output keeps its existing release points.
