---
"@opengeni/api-router": patch
---

When an agent's Skill, workspace instruction or Knowledge save is refused, the result it gets now says why in plain words (for example, Agent learning is Off for this change in the chat's or the workspace's settings), names what would make it succeed, and asks the agent to tell the person it was not saved. It no longer says "Do not ask for approval to continue", which agents read as a reason not to mention the failure.

`skill_save` gains an optional `scope` argument (`personal` or `workspace`) so an agent in a private chat can create a Skill for the whole workspace when the person wants that. Its description and the `instruction_policy_save` description now say that a private chat can save workspace Skills and instructions, under the workspace's learning mode, instead of telling the agent to keep to personal scope.
