---
"@opengeni/db": patch
---

An agent now saves learning to the destination it explicitly chooses, in both directions: a shared chat can save the initiating person's own personal Skill, and a private chat can correct or add workspace Knowledge. Each change follows the stricter of the chat's and the destination's Agent learning mode, so Review first leaves a pending proposal and Off refuses it. Another person's Skill, a chat with no person to save for, and removing a Skill outside the chat's own learning scope stay refused.
