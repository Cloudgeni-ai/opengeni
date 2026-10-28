---
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
"@opengeni/react": minor
---

A Codex chat can now switch to any other model in the same chat. Chats that use ChatGPT's own memory of long conversations (remote compaction) used to be locked to Codex models, so a used-up Codex plan left them stuck. Now picking another model just works: before its first reply, the chat's earlier messages are summarized again from Opengeni's stored history, so the new model can read them, and the chat keeps a shared summary from then on. The transcript shows one short note, "Earlier messages summarized for the new model". When a Codex usage limit stops a chat, it offers "Continue with <model>", which switches that chat and carries on. The "Keep Codex chats portable" workspace setting is gone because switching always works; the `codexCompactionDefault` API field is still accepted. The `codex_compaction_v2_provider_locked` error code stays in the contracts for older clients but is no longer returned.
