---
"@opengeni/react": minor
"@opengeni/sdk": minor
---

Expose the stock new-conversation controller and view used by `OpenGeniChat`.
Keep uncertain retries tied to their original creation, preserve newer text,
files and model choices through native draft handoff, and support opt-in
voice-first creation without a synthetic prompt. The session proxy preserves
browser creation idempotency keys unless its server hook supplies its own.
Simple embeds continue to use the same one-component API.
