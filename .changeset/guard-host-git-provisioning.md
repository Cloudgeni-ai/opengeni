---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Git credential provisioning scripts (the repository clone setup and both token refresh commands) now refuse to run unless the sandbox lifecycle hook marks the command as targeting a sandbox. Executed directly on a developer or host machine they exit with status 78 before touching `$HOME/.opengeni` or the global Git configuration, instead of replacing that user's credential helpers. The runtime's clone and renewal hooks add the marker, so sandbox behavior is unchanged.
