---
"@opengeni/db": patch
---

A voice call now hears the agent's actual answer when the agent ends its turn by waiting for input. That answer is stored as the turn's `reply` with an empty `output`, and the realtime projection read only `output`, so the voice model received an empty result and made an outcome up. The projection now uses `output`, then `reply`, and when a turn finished with neither it says so explicitly instead of sending empty text.
