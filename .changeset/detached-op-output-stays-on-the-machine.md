---
"@opengeni/agent-proto": patch
"@opengeni/runtime": patch
---

A command's output is no longer streamed to nobody after the call that launched or read it returns. `OpAck` gains `detach`: the consumer stops following the operation, and agent 0.1.159 stops sending its frames while the command keeps running and its output stays retained for the next read. Previously the departing consumer granted unlimited credit, so every yielded launch or read made the agent push the command's entire retained output over the machine's single shared output connection, delaying other commands' output and completion by minutes on a slower link. Older agents keep the previous behavior.

A `command_read` or `command_wait` that refreshes a background command whose result Opengeni had just stored and released no longer fails with "the runner reported it lost": it reads the stored result.
