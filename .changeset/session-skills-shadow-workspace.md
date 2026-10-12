---
"@opengeni/worker-bundle": patch
---

A Skill that a session carries itself now shadows a workspace Skill with the same name. The Skill index and skill_search list only the session copy, and reading the Skill by name returns it instead of failing as ambiguous; the workspace copy stays readable by its exact id.
