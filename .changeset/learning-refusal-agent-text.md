---
"@opengeni/api-router": patch
---

Agents now choose where a remembered rule or fact is saved, and they tell the person when a save is refused.

`skill_save` and `skill_publish` gain an optional `scope` argument (`personal` or `workspace`), and `knowledge_save` gains an optional `scope: "workspace"`. With it, an agent can save a new Skill or Knowledge entry for everyone, or a Skill for only the person it acts for, when the person wants that. The descriptions of `skill_save`, `knowledge_save` and `instruction_policy_save` now say where a save goes by default. An explicit destination still follows its own Agent learning mode.

When a Skill, workspace instruction or Knowledge save is refused, the result says "Nothing was saved" and why in plain words. If the agent can fix the problem itself, it says how to retry. Otherwise it says what would make the save work and asks the agent to tell the person. It no longer says "Do not ask for approval to continue".
