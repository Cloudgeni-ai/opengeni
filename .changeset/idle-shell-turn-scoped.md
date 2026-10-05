---
"@opengeni/runtime": patch
---

A yielded shell command whose last step is a bare interactive shell (for example `bash --noprofile --norc`) now stays turn-scoped and is stopped when the turn ends. It is no longer adopted as a session background command that keeps the sandbox busy indefinitely.
