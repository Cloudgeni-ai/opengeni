---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
---

Chats bound to an agent revision (`sessions.agent_prompt_revision`) get the agent's Instructions as their own system-prompt layer, with a short preamble saying they grant no extra authority, and with `experimentSystemPromptCacheSplit` on and the deployment persona every chat of one agent shares a cached prompt prefix. An edit made during a chat reaches the model as a developer history item before the next turn instead of rewriting the system prompt, and compaction folds the newest revision back into the prompt. A deleted agent leaves a plain chat. Migration 1246 refuses such chats to workers that do not add the layer; the chat waits for a Resume or a new message rather than failing. Nothing sets `agent_prompt_revision` yet, so existing chats are unchanged. New exports: `AGENT_INSTRUCTIONS_PREAMBLE` and `agentInstructionsLayerContent` (runtime), the agent instructions context helpers (contracts), `readSessionAgentPrompt` and `ensureSessionAgentInstructions` (db), and the `agent_instructions` model-context layer id (contracts and sdk).
