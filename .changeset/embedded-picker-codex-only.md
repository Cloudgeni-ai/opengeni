---
"@opengeni/react": patch
---

The default model picker in `SessionConversation` now disables other providers' models in a session locked to Codex remote compaction, as the API refuses them there, instead of offering them.
