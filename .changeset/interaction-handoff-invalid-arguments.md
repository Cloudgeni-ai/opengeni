---
"@opengeni/runtime": patch
---

An invalid human-handoff request no longer fails the agent's turn. The handoff tool pauses for a person before it runs, and its arguments were only checked after that pause, so a request with a wrong value type (for example a number sent as a string) stopped the whole turn with a raw validation error. The arguments are now checked before the pause, like the human-input question tool, and the model gets a tool result naming the fields to correct, with nothing requested.
