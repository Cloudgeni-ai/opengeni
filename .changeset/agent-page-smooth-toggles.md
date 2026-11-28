---
"@opengeni/react": patch
---

Toggles that swap a list (Agents All/Yours, an agent's Recent work, an app's Active/Archived chats) keep the old list, dimmed, until the new one loads, then fade it in; the new `ui/content-swap` module does this and respects reduced motion. On an agent's page, When it works no longer runs into the header, the Learns Memory list shows the five newest entries with "See all N in Knowledge", and a ready-made agent is offered only its own suggested triggers.
