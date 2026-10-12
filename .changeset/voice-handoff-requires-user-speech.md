---
"@opengeni/db": patch
---

Ending a voice session no longer starts or steers an agent turn when the remaining transcript holds only voice-assistant lines. Assistant chatter such as "Still checking." could previously supersede a running turn or wake an idle session; the handoff now requires at least one finalized user transcript after the latest delegation.
