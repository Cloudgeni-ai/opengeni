---
"@opengeni/db": patch
---

Chrome profiles on a personal or organization-wide Connected Machine now appear and open in every workspace where that machine can be used, not only the workspace it was enrolled in. Browser and computer sessions record which workspace their profile is stored in, keep using that exact profile, and end when its Chrome restarts. Deleting the workspace a profile is stored in is never blocked by sessions elsewhere that used it.
