---
"@opengeni/runtime": patch
---

A command on a sandbox whose agent stops answering no longer waits silently for up to fifteen minutes. When the agent has not answered a command's start for three minutes, the command ends with an offline error. On a cloud computer, Opengeni first checks whether the agent answers and, if it does not, restarts the computer once per turn; the error then says what happened, for example "this chat's cloud computer stopped responding and didn't come back. Opengeni restarted it; re-run the command." On a Connected Machine it says the machine stopped responding and asks the person to check that it is on, awake and connected. A busy agent that keeps answering is still waited for.
