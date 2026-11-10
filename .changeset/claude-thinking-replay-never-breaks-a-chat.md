---
"@opengeni/runtime": patch
"@opengeni/react": patch
---

Replayed Claude thinking no longer breaks a chat. Claude's signed thinking now follows the same replay policy as OpenAI encrypted reasoning: each block records the binding it was issued under (platform, account, model and, for prefix-bound models such as Opus 5.5, the system prompt), and a request under any other binding replays it as readable historical reasoning instead of a signature Claude would refuse. This covers system prompt changes between turns (for example a repository Skill added mid-chat), model, account and transport switches, and works on every Claude transport. History stored before this change stays native until Claude refuses it; that 400 is then sent once more with the refused blocks as text and remembered for the provider. If Claude still refuses, the turn fails with the code `anthropic_reasoning_replay_rejected` and a short message instead of Claude's raw error text.
