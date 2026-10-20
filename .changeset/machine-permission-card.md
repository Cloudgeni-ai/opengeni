---
"@opengeni/api-router": patch
"@opengeni/core": patch
---

When an agent tries to use someone's personal (Only me) computer that they have not yet allowed in the chat, the chat now shows them the card to allow it right away. The agent is told the card is there, so it says so in one sentence instead of waiting or retrying the same command. Cards for other connections, such as Slack and GitHub together, are not limited; only a repeated refusal in the same turn reuses that turn's computer card.
