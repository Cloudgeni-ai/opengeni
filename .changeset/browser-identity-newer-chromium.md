---
"@opengeni/browserd": patch
---

A saved browser identity now opens in the Chromium build that saved it or any newer one, so a placement whose Chromium has updated since the save keeps its sign-ins. Chromium migrates a profile forward itself, and the saved revision is never changed. Only an older build is refused, and the refusal names both versions. A placement on another operating system or architecture is still refused, and the message now says where the identity can open, or that the agent should open a new browser and sign in again.
