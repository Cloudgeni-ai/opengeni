---
"@opengeni/db": patch
---

An agent in a private chat, or a chat using personal memory, can now save to the workspace when it explicitly chooses to: it can change an existing workspace Skill, create a Skill with scope `workspace`, or propose a workspace instruction. Previously both were refused, so a person's request to remember a workspace rule from a private chat was lost. Other learning from such a chat still saves only for that person.

A workspace change from a personal chat follows the stricter of the chat's own Agent learning mode and the workspace's mode for that category, as of when the work was accepted. Off refuses it, and Review first leaves a pending proposal in workspace review. Permanently deleting a workspace Skill still needs a shared chat or a person. A shared chat still cannot choose a personal destination or change someone's personal Skill.
