---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Every 1:1 message and install in Microsoft Teams now gets a reply with a way forward. In an organization that hasn't connected Opengeni, `help` and `unlink` carry the Connect your organization button (or tell non-admins to ask their admin), and once a person's or tenant's cards are used up, a short reminder to send `help` answers instead of silence. A personal Microsoft account is told that Opengeni needs a work or school account. A linked person who can't start chats in the connected workspace is told why and to ask a workspace admin for access, and `unlink` from someone who isn't linked offers linking. The not-available notice names `OPENGENI_SUPPORT_EMAIL` when it is set, and help and the welcome name it when there's no self-serve setup. Mentions in a group chat or channel that isn't turned on, or in an organization that isn't connected, get a short bounded reply. Onboarding reply limits are now counted in the database across API replicas (migration `1296_teams_bot_onboarding_limits.sql`) instead of per replica, falling back to memory when the database can't be reached.
