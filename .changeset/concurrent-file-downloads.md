---
"@opengeni/runtime": patch
---

Attached files reach the sandbox faster. Each attached file used to download in its own sandbox command, one after another, and each command cost a full provider round trip even for a tiny file, so a turn with ten attachments waited about ten seconds before the model could start. Independent files now download up to six at a time. Downloads that write the same path still run in order, and any failures are reported in the same order and wording as before.
