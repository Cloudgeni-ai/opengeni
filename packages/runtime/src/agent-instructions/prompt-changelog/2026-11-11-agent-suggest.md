# Offering an agent

When the `agent_suggest` tool may exist, Working with the user adds one
sentence after the repeated-ask rule. A chat used mostly for the same kind of
work, with at least three such requests in a row (the tool refuses fewer), can
now offer the person an agent, once: make one from this chat (a name,
description, icon and Instructions the agent drafts), or use an agent that
already does the work. The tool only records a card on the chat; nothing
changes until the person accepts. Only the modular composition can render it;
legacy bytes are unchanged. Size: +275 bytes (the sentence plus its separating
space) in every modular case where the tool may exist; none elsewhere.

```diff
+ When most of the user's requests in a chat are the same kind of work, including the last three or more in a row, call `agent_suggest` once in that chat, preferring an agent that already does the work: it offers them an agent as a card and changes nothing until they accept.
```
