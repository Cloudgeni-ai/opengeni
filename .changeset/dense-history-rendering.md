---
"@opengeni/react": patch
---

Increase browser conversation retention from 8 MiB / 10,000 events to 160 MiB / 200,000 events, reducing eviction during history navigation without changing fetch sizes or folding behavior. Account for appended event bytes incrementally instead of serializing retained history on every live batch.
