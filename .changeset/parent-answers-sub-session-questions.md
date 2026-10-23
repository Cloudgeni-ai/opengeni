---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

A sub-session's question can now be answered by the person or by the parent agent, and the first answer wins. The parent's `child_requires_action` notice now carries each question's id, kind, prompt and option ids and labels (never secret specs), so the parent can answer with `session_human_input_respond` without reading the sub-session's history. The notice now also wakes an idle parent that has no goal. An agent whose answer arrives after someone else's gets `outcome: "unchanged"` with `alreadyAnswered: true`, who answered, and a warning not to answer again; before, it got a success-looking `replayed` result. The `user.humanInputResponse` event records whether a person, API key, agent or the system answered. The agent instructions and the `request_human_input` and `session_human_input_respond` descriptions now say that a parent answers when it can from its task context, leaves questions only a person can answer (decisions, preferences, credentials, approvals) to the person, and never answers on the person's behalf. The conversation now says "Agent answered" instead of "You answered" when an agent gave the answer.
