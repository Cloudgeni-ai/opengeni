---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A configured agent no longer gets `wait_for_input` and its waiting guidance only because it can ask a person a question: an answer resumes the paused turn and a new message starts one, so the prompt is the same whether the API or a person started the turn. A configured session with no sandbox, Connected Machine or `run_on` no longer gets the Codemode guidance. The Final answer sentence about reporting web sources needs `webSearch` or `browser`, and "Answer in chat by default" needs `artifacts`. Sessions that have these features keep the same prompt.
