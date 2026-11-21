---
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

A sub-agent's question now goes first to the agent that started it. You no longer get a card, inbox item or phone notification for it while that agent can still answer. If the agent's turn ends without an answer, the question reaches you as before. Questions only you can answer (passwords and other secrets, Skill reviews, approvals) still come straight to you. Sessions gain an optional `questionWithAgent` flag, and Needs you and the attention counts leave such sessions out.
