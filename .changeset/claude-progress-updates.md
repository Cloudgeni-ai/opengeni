---
"@opengeni/runtime": patch
"@opengeni/config": patch
---

On Claude Opus 5.5 and Sonnet 5.5, a note the agent writes for the person right before a tool call now shows as a normal assistant message and counts as a visible reply. Before, it showed as a collapsed thought. These models request Claude's progress-update thinking display, and each update's signed block is replayed unchanged in its original position.
