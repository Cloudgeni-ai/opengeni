---
"@opengeni/db": patch
---

A `personalResourceAttachment` on a chat that uses no personal Rig or Connected Machine is still refused with 422, but the refusal now says there is nothing to attach and that Connections are chosen with `connectionAccounts`, instead of the generic "The personal-resource attachment request is invalid".
