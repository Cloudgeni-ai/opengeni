---
"@opengeni/runtime": patch
---

A native computer tool call (list_windows, get_window_state, click and the other CUA tools) that the API refuses before dispatch, for example because the ComputerSession was retired when the agent moved to another machine, now returns that refusal as a tool error with its code and message. Before, a direct call reported it as a generic failure asking the model to try again, and a Code Mode call reported an operation of unknown outcome.
