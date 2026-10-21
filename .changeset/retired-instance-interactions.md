---
"@opengeni/db": patch
"@opengeni/react": patch
---

A browser or desktop whose sandbox instance is gone no longer keeps the sandbox warm. When a sandbox lost, drained or replaced the instance a browser or desktop controller ran in, the resource stayed `active` forever and its holder kept every later box of that sandbox warm on every provider, so it never idle-drained. The interaction reaper now marks such a resource `lost` (`placement_instance_lost`), settles its pending operations and releases its holder, and the sandbox drains normally. Resources on the current instance are untouched.
