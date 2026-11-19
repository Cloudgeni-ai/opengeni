---
"@opengeni/contracts": patch
---

Prompt-cache warm-miss classification checks the idle gap first, so a tools or system change after the cache lifetime counts as `idle_gap` rather than a within-deployment prefix change, and a call whose fingerprint has no release counts as another deployment (`release_changed`) when the other call recorded one. A compaction whose fixed prefix keeps the prompt above 60% of its tokens is recognised by its item count and classed `context_replaced`.
