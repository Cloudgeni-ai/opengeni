---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Sandbox: on Modal, a chat whose sandbox setup was cut off mid-start no longer keeps an unused sandbox running for up to a day. After the idle grace the workspace is saved, the sandbox is stopped, and the chat resumes on the saved workspace. A sandbox that was already shutting down is now also saved before its provider deadline instead of being stopped without a save, which previously made the resumed chat fail.
