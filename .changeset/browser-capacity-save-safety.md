---
"@opengeni/browserd": patch
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
---

Making room on a full browser controller is now safer. A browser is saved to make room only if it is still idle, active on the same controller and free of other operations at the moment it is claimed, and a browser another request already saved no longer counts as room made. A failure while preparing the save returns the browser to active instead of leaving it stuck suspending. Downloads kept when any browser is saved stay private to the owner of a private chat instead of becoming workspace files, and are read back as that owner once the request is authorized for the chat. The memory-based browser limit now honours memory limits on the controller's own nested cgroup and its ancestors.
