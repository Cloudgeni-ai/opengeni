---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Reading a session's stored bundled Skill selection now drops ids this build does not know instead of failing the whole session read. Dropping only narrows the stored selection; API input still rejects unknown ids. The bundled `document-parsing` guide now ships the upstream AnyDoc MIT license and a `SOURCES.md` attribution, and the `skill_install` description no longer claims that `skill_search` returns library ids.
