---
"@opengeni/runtime": patch
---

Fix Mac browser text replacement by sending Chromium's select-all editing command, including explicit Command+A. Attached Chrome retains its connected machine's keyboard platform. Empty fills and Unicode replacements use normal browser input events and existing outcome verification.
