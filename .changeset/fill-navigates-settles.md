---
"@opengeni/browserd": patch
---

A browser fill whose own input navigates the page, or makes the page replace or remove the field (a one-time-code form that submits itself once complete), now reports done with the page it led to, instead of `outcome_unknown` with a raw "Cannot find context with specified id" or "Node with given id does not belong to the document" message. A field that is still there but holds a different value is still reported as `outcome_unknown`.
