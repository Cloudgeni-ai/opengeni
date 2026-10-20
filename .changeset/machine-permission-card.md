---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/db": patch
---

When an agent tries to use someone's personal (Only me) computer that they have not yet allowed in the chat, the chat now shows them the card to allow it right away. The agent is told the card is posted in the chat and gets the chat link, so it tells the person in one sentence (or gives the link when they are reading in Slack or a worker chat) instead of waiting or retrying the same command. Cards for other connections, such as Slack and GitHub together, are not limited; only a repeated computer refusal in the same turn reuses that turn's computer card, even when several are refused at once.
