---
"@opengeni/worker-bundle": patch
---

Reject provider responses that render internal agent/tool transcripts as assistant prose, quarantine transcript markers from the live event stream, and retry only when no structured tool activity makes replay ambiguous.
