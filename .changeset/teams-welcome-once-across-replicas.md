---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Installing the Microsoft Teams app for yourself sends one welcome (or one Connect your organization card) again. Teams may accept a message that carries a card with an empty response and no message id; the bot treated that as a failed send, answered the install with an error after the welcome had arrived, and Teams redelivered it to another API replica, which welcomed the person again. A message Teams accepts without an id now counts as delivered, an install never fails because of its welcome, and each chat's welcome is claimed once in the database across replicas and redeliveries (migration `1290_teams_bot_welcomes.sql`), replacing the per-process memory. The same fix stops an unlinked person's message from failing, and being answered twice, when Teams returns the account-link card without an id.
