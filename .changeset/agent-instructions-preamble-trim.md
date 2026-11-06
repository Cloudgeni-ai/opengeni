---
"@opengeni/runtime": patch
---

The preamble on an agent's Instructions layer (`AGENT_INSTRUCTIONS_PREAMBLE`) is shorter, 56 bytes fewer. It keeps the same meaning: the instructions take precedence over the default behavior, grant no additional authority, and a later developer message may replace them. Only chats bound to an agent see it; their system prompt changes once, and plain chats are unchanged.
