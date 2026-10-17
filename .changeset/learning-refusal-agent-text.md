---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Agents now choose where a remembered rule or fact is saved, and a refused save always reaches the person.

`skill_save` gains an optional `scope` argument (`personal` or `workspace`), and `knowledge_save` an optional `scope: "workspace"`, so an agent saves a new Skill or Knowledge entry for everyone, or a Skill for only the person it acts for, when the person wants that. The descriptions of `skill_save`, `knowledge_save` and `instruction_policy_save` say where a save goes by default and that an explicit destination still follows its Agent learning mode.

When a Skill, workspace instruction or Knowledge save is still refused, the result says "Nothing was saved", why in plain words and what would make it work, and asks the agent to tell the person. It no longer says "Do not ask for approval to continue".

The "Not saved" timeline row now appears only for genuine refusals: Agent learning is Off, the chat is not allowed to make the change, or a Site agent. The `personal_chat` and `personal_target` reasons are removed (stored facts with them read as not allowed), and the row never asks the person to make the change by hand. `@opengeni/sdk/learning-refusal` now exports only `learningRefusalFromToolOutput` and the `LearningRefusal` type, `@opengeni/contracts` no longer re-exports the refusal fact from its root (use `@opengeni/contracts/learning-refusal`), and `@opengeni/react` no longer exports `LearningRefusalRow`.
