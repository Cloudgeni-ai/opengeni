---
"@opengeni/react": patch
---

Keep assistant progress and prior replies readable in independent turn summaries,
with rolling tool activity and truthful Working/Worked timing. Remove cross-turn
folding, text-length display inference, and forced answer anchoring. Add a single
Latest question navigation callback backed by bounded durable history lookup.
Keep expanded outer work headers reachable with section-scoped stickiness,
without stacking nested headers or changing timeline scroll ownership.