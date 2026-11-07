---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Replies the Microsoft Teams bot sends itself (help, link, unlink, the link card, onboarding replies, reminders and notices) now go out once per message across API replicas and redeliveries. Teams redelivers a message after a slow or failed response; each reply is claimed in the database just before it is sent (migration `1301_teams_bot_reply_claims.sql`), so messages that get no reply write nothing, and the claim is given back only when nothing reached the person and Teams clearly refused the reply, so the redelivery can answer. Notice cards such as "Started" now carry a plain-text summary and card fallback text for clients that can't show cards.
