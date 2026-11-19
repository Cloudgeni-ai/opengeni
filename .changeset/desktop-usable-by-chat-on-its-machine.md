---
"@opengeni/api-router": patch
---

A Desktop on a Connected Machine can be used by another agent chat working on that machine (a child given its parent's Desktop, say) after the chat that opened it has moved to another machine. Before, every request was refused with "this task now runs on another machine", even after the calling chat moved to the Desktop's machine, because only the opening chat's route counted. The request now goes through the calling chat's own route when it works on that machine. Requests from a chat on another machine are refused as before.
