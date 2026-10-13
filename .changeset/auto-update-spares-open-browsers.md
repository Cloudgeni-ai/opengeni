---
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

Automatic agent updates no longer close open browsers. Agents before 0.1.58 close every managed browser when they restart, so the automatic updater now leaves such a machine on its current agent while it still has a managed browser that may be open, and looks again on the usual busy backoff. The machine card shows "Update to vX postponed: open browsers would close" and notes that updating by hand closes them; "Update now" still works. Agents from 0.1.58 on keep their browsers across a restart and are updated as before.
