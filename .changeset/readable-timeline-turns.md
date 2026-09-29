---
"@opengeni/react": patch
---

Keep assistant progress and prior replies readable in independent turn summaries,
with rolling tool activity and truthful Working/Worked timing. Remove cross-turn
folding, text-length display inference, and forced answer anchoring. Add a single
Latest question navigation callback backed by bounded durable history lookup.
Keep expanded outer work headers reachable with section-scoped stickiness,
without stacking nested headers or changing timeline scroll ownership.
Resolve Latest question against authoritative queue/lifecycle state: focus pending
prompts in SessionChrome, restore distant started prompts at their actual turn
boundary, and skip withdrawn prompts without getting stuck on invisible rows.