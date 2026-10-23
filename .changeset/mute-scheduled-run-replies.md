---
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Muting replies on a run of a schedule that starts a new chat each time now mutes the whole schedule, so later runs stay quiet. The session menu says "Mute this schedule's replies" there, and `SessionInboxMute` carries an optional `scope`.
