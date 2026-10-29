---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/runtime": minor
"@opengeni/db": patch
"@opengeni/react": minor
"@opengeni/react-native": minor
"@opengeni/worker-bundle": patch
---

Question cards offer "Let the agent decide". On every ordinary question (never a secret, a Skill review or a secret approval; tool approvals stay human-only) one secondary action replaces Skip and settles the request as `{ outcome: "skipped", agentDecides: true }`, accepted even when the request does not allow an ordinary skip. The agent's tool result carries a note to make its own best choice and say in one sentence what it chose, and the settled card reads "You let the agent decide". On a sub-session's question shown in a parent chat, the action instead sends the parent's own agent a message naming the exact request; the card says "Your agent is deciding" and stays answerable, and the message shows what the agent decided once the sub-session's request settles. `HumanInputForm` takes `onLetAgentDecide` and `agentDeciding`, `HumanInputSurface` forwards them, and `humanInputAgentMayDecide` tells which requests qualify.

A sub-session's blocking question now also wakes a parent whose goal is completed (the goal is not reopened), so the parent agent can answer it before the person has to. Before, such a parent kept the notice unread and the person was the only one asked. Agents are told to answer a child's question from their task context before the person has to, and to do the agent work it asks for (such as starting a reviewer) and then answer. The `request_human_input` description tells a sub-session to message its parent agent, rather than ask the person, when what it needs is agent work.
