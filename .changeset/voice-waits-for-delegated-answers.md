---
"@opengeni/api-router": patch
"@opengeni/sdk": patch
---

Voice no longer makes up an answer while the agent is still working on a question. On WebSocket voice models (Eleven Realtime, AI Gateway, SuperGrok) the delegation tool call used to stay unanswered until the agent finished; Eleven Realtime stops waiting for a tool result after about 20 seconds and lets the model carry on with nothing to go on, so it stated invented facts, and it dropped the agent's later answer for that call. The call is now answered at once with a "running, you don't have the answer yet, say you're checking" output, and the agent's answer arrives as its own `<execution_result>` item with a response request. The realtime instructions now say that progress is the agent's working notes, not findings, and that while a delegation runs the voice must not answer the question itself from general knowledge, session history or progress.
