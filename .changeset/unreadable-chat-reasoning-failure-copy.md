---
"@opengeni/react": patch
"@opengeni/contracts": patch
"@opengeni/codex": patch
---

When a model refuses encrypted reasoning that another model or account left in the chat, the failed-turn banner now says "This model can’t read earlier reasoning in this chat." and points at the model picker, instead of "The session stopped unexpectedly." Retry stays, and the provider's exact text stays behind Details. The runtime's recovery and the banner share one rule for recognising this refusal (`@opengeni/contracts/encrypted-reasoning-refusal`).
