---
"@opengeni/runtime": patch
---

Claude and Chat Completions requests now keep a step's parallel tool results together when history holds other items between them (for example a browser or computer tool family disclosure after an entry call that was not the step's last). Such chats previously failed every turn with "Claude tool results are incomplete"; they now continue on their existing history.
