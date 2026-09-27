---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A repeated default `skill_read` of the same Skill no longer returns the full `SKILL.md` again while that exact text is still in the session's active model history. The model receives a short `alreadyInContext` receipt with the current revision identity instead. Reads that compaction removed from history count as absent, so the next read returns full text. A stored read counts only if the current model receives it untruncated under its own tool-output bound, and a failed history lookup returns full text. Explicit `paths` (including `["SKILL.md"]`), `listFiles`, and Codemode callers always receive content. The tool schema, instructions, and Skill index are unchanged, so the cached prompt prefix is unaffected. `@opengeni/db` exports `getActiveSessionFunctionToolResults` for the active, call-paired results of one function tool.
