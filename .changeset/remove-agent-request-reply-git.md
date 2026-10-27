---
"@opengeni/agent-proto": patch
"@opengeni/runtime": patch
---

The machine agent no longer serves the request/reply Git operation (`ControlRequest.git`). No current Opengeni server sends it: Git runs as an ordinary command. The wire protocol reserves the field numbers, and `GitRequest`, `GitResponse`, `GitOp`, `GitStatus` and `GitFileStatus` are gone from the generated types.
