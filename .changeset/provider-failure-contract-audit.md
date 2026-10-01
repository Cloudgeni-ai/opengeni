---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Recognize documented OpenAI and Claude spend limits, ramp/overload and safety failures. Keep unknown Claude stream errors conservative, preserve authoritative HTTP refusals, and honor Azure millisecond retry hints without changing side-effect recovery boundaries.
