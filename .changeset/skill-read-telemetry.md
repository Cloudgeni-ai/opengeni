---
"@opengeni/contracts": minor
"@opengeni/runtime": minor
"@opengeni/worker-bundle": patch
---

Count Skill reads and record a content-free Skill-use fact on each model `skill_read` event. The worker increments `opengeni_skill_reads_total{source, skill, kind, caller}`, where `skill` is a built-in id or `custom`, so tenant Skill ids, names, and requested identifiers never become labels. A successful model read also carries `_meta["opengeni/skillUse"]` (resolved id and source, ledger revision or whole-artifact digest, result kind, returned bytes, whether the Skill was in this turn's model-visible index, and whether `skill_search` returned it earlier in the attempt). MCP `_meta` never reaches the model, so the model-visible result and model history stay byte-identical; only the `agent.toolCall.output` event projection keeps the fact. Codemode results never carry it, and it is dropped rather than let a result cross the 1 MiB model-visible cap. `@opengeni/contracts` exports `SkillUse`, `SkillUseSource`, `SkillReadKind`, `SKILL_USE_META_KEY`, and `skillUseFromToolOutput`; `@opengeni/runtime` exports `skillCatalogEntryIds` and `modelToolResultFits`.
