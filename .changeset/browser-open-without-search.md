---
"@opengeni/runtime": patch
---

Browser and computer tasks start without a tool search. `browser_open` and `computer_open` are visible from the first request, and opening one shows the rest of its tools (observe, act, screenshot, tabs) right after the open result, frozen so later requests reproduce the same prefix. Tagged-union summaries also list a tag once when several variants share it.
