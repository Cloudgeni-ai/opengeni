---
"@opengeni/core": patch
---

A compute sandbox is no longer refused as "built with an older agent" just because its first heartbeat was recorded before its Hello. A desktop sandbox's heartbeat records the desktop state among the agent's capabilities, and a session's first request could arrive in that moment and see capabilities without `OpRelease`. A sandbox is now refused only once its Hello has recorded the agent's version and what it serves.
