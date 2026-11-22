---
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

A sub-agent's question now goes first to the agent that started it. While that agent can still answer, you get no inbox item or phone notification for it, and Needs you and the attention counts leave it out. It reaches you as before if the agent's turn ends without an answer, the agent's turn fails, or the same pause also needs you. Questions only you can answer (passwords and other secrets, Skill reviews, approvals) still come straight to you. Sessions gain an optional `questionWithAgent` flag.
