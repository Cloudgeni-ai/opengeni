---
"@opengeni/browserd": patch
---

When Chrome ends a tab's debugging during a fill (another extension's autofill frame appearing as the field gets focus), the fill now reports completed if the field holds the requested value on the new attachment, instead of an unknown outcome.
