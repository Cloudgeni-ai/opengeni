---
"@opengeni/runtime": patch
"@opengeni/react": patch
"@opengeni/worker-bundle": patch
---

Preserve the original shell command when adopting background processes, so running command rows and completion notices show the command instead of execCommand. Keep long command rows ellipsized and expose their saved preview on hover and expansion.
