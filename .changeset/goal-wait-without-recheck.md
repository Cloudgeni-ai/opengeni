---
"@opengeni/worker-bundle": patch
---

Allow goal continuations to suspend for work already in flight without a mandatory preliminary status check. Preserve tool-availability gating, event-driven resumption, and safety deadlines.