---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

The system prompt no longer changes when repository Skills are added or removed, the workspace becomes unreachable or degraded, or a turn switches between deferred and indexed Skill discovery. It keeps one stable "Repository skills" notice, and the live index reaches the model as a durable "Repository skills" developer history item, written only when it changes, frozen per turn and placed before the turn that first sees it. The current run sees the item at the same position later turns load it from, so earlier signed Claude thinking and cached prefixes stay valid. The one-shot request for a missing session title is now part of the turn's operational notice instead of being appended to the first request's system prompt. New exports: `ensureSessionRepositorySkills` (`@opengeni/db`), `repositorySkillsContextItem`, `readRepositorySkillsContext` and `latestRepositorySkillsIndex` (`@opengeni/contracts`), and the `publishRepositorySkills` agent option (`@opengeni/runtime`).
