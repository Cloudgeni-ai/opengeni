---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/runtime": patch
---

New optional `agent.titleInstructions`: host-provided text that tells the automatic title request how to write a chat's titles, for example "If the messages have no clear language, write the title in Norwegian bokmål." The title request appends it after its unchanged fixed rules. It is stored in the chat's agent configuration only when set, children inherit it, a running session can change it, and `null` clears it. Chats without it are unchanged.
