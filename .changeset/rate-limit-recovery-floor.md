---
"@opengeni/worker-bundle": patch
---

Rate-limited turns now back off with an escalating floor (10 s, 20 s, 40 s, 60 s, 120 s), and a longer provider `Retry-After` still wins. Previously a one-second `Retry-After` on a per-minute token limit used up all five automatic recoveries within seconds and failed the turn.
