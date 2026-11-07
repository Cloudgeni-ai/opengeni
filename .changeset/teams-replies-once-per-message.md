---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Replies the Microsoft Teams bot sends itself (help, link, unlink, the link card, onboarding replies, reminders and notices) now go out once per message across API replicas and redeliveries. Teams redelivers a message after a slow or failed response; each reply is first claimed in the database (migration `1301_teams_bot_reply_claims.sql`), and the claim is given back only when Teams clearly refused the reply, so the redelivery can answer. Notice cards such as "Started" now carry a plain-text summary and card fallback text, so Teams notifications show a preview instead of an empty card.
