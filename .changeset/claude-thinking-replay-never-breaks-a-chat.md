---
"@opengeni/runtime": patch
"@opengeni/react": patch
---

Replayed Claude thinking no longer breaks a chat. Claude's signed thinking now follows the same replay policy as OpenAI encrypted reasoning: each block records the binding it was issued under (platform, account, model and, for prefix-bound models such as Opus 5.5, the system prompt), and a request under any other binding replays it as readable historical reasoning instead of a signature Claude would refuse. This covers system prompt changes between turns (for example a repository Skill added mid-chat), model, account and transport switches, and works on every Claude transport. History stored before this change stays native until Claude refuses it. A refused replay never fails the turn: the request is sent once more with the refused blocks as readable text (remembered for the provider), and if Claude refuses that too, once more with plain history that carries no opaque provider state. Each fallback is recorded for operators as a thinking-blocks-dropped reason and is never shown to the person.
