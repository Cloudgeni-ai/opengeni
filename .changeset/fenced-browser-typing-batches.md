---
"@opengeni/browserd": patch
"@opengeni/contracts": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
---

Negotiate bounded viewer typing batches from the active browser controller. Preserve
individual text events and input order while reducing request overhead; recheck the
original document fence before each action and discard uncertain queued input
without replay. Older controllers retain sequential input.
