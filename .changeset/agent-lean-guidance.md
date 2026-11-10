---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/runtime": minor
---

Add `agent.guidance: "full" | "lean"`. `"lean"` is for short conversations where a person answers each reply, such as support or booking assistants: the system prompt keeps identity, precedence, authorization limits, when to ask, destructive-action care, new-message handling, compaction and the guidance of the tools the session has, and leaves out autonomy, progress-update, verification and final-answer detail. An embedded `capabilities: "none"` session without a sandbox goes from about 2,750 to about 900 system-prompt tokens per call. It is accepted wherever the agent object is (session create, chat facade, proxy, schedules, workspace defaults, running-session updates), children inherit it, and the default is unchanged.
