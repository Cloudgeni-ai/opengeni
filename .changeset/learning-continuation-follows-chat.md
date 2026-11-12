---
"@opengeni/db": patch
---

Continuation turns (goal continuations, finished waits and background commands, child results) now take the learning modes their chat accepted most recently, instead of the modes of the turn that originally caused them. Before, a chain of continuations could carry settings from days earlier while turns started by a person or a schedule used the current settings, so a chat alternated between old and new modes after a settings change and re-sent its full governance block on every alternation. A chain with no later turn in the chat keeps exactly the policy it was accepted under, explicit chat overrides still win, scheduled-run provenance still follows the cause, and a child's first turn still inherits from its parent turn.
