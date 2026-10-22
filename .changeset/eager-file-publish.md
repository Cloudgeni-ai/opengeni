---
"@opengeni/runtime": patch
"@opengeni/api-router": patch
---

`sandbox_file_publish` is on the first model request, like the other harness control tools, so a task that hands the person a file no longer spends a tool search to find it. Its description is also shorter (about 20% fewer characters) and names the session's workspace instead of a fixed /workspace path.
