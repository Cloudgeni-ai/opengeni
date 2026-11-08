---
"@opengeni/react": patch
---

A new-chat form emptied after Send no longer clears a newer draft from another of the person's devices, for example when the post-Send read failed or a reconnect read it without showing it. An autosave of a box holding no message now checks a newer draft before saving: another device's message is kept and the form follows it, while a draft holding no message is saved over as before, so model, project and visibility picks still win. Clearing the box over a message the form never showed now brings that message up instead of erasing it; clearing it again erases it. Typing still saves on top of a newer draft.
