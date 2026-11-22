---
"@opengeni/api-router": patch
---

A browser on a Connected Machine can be used by another agent chat working on that machine (a child given its parent's browser, say) after the chat that opened it has moved to another machine, as a Desktop already can. Before, opening, resuming, controlling or saving it was refused with "this task now runs on another machine", even though the calling chat was on the browser's machine, because only the opening chat's route counted. The request now goes through the calling chat's own route when it works on that machine, authorized for that chat. Requests from a chat on another machine are refused as before.
