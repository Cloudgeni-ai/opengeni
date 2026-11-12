---
"@opengeni/agent-host": patch
---

A finished command no longer keeps a file descriptor open while the agent holds its output. When a command's output spills to disk, the agent kept the spool segment's append handle open until the output was released or evicted, so every completed command waiting for its final acknowledgement held one descriptor. Retained results can number in the thousands, which a 1024 soft limit can't cover. A busy sandbox then hit `EMFILE` and couldn't start `/bin/sh` for new commands. Writing the command's exit record now closes the handle, and reads open their own as before. Running commands are unchanged.
