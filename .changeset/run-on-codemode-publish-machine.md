---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

`sandbox_file_publish` called through Codemode from code that a `run_on` exec runs on another machine now publishes the file from that machine, where the code made it, instead of looking for the same path on the chat's active sandbox. The exec's Codemode token names the machine it runs on, the Codemode call records it, and publishing checks access to that machine exactly as `run_on` does. When the machine can no longer be reached, the call fails with `run_on`'s own reason rather than publishing a different file. Model calls and code on the active sandbox resolve paths as before.
