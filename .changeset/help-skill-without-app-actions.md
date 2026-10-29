---
"@opengeni/runtime": patch
---

The bundled Opengeni help guide now tells agents to load the three app-action tools by exact name in one tool search. In chats started through the API, an SDK or another product's embed, where those tools may not exist, the agent stops there instead of searching and browsing the tool catalog, and says in one sentence where the change is made.
