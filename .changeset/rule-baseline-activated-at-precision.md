---
"@opengeni/db": patch
---

`remember` with `lane: instruction_policy` no longer fails after a governed-learning rule activation: the onboarding-proposal insert now copies the head's `activated_at` baseline in SQL instead of round-tripping it through a millisecond JS `Date`, so the draft trigger's exact comparison holds against the microsecond `clock_timestamp()` value the governed-learning controller writes.
