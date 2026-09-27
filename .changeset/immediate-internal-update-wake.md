---
"@opengeni/db": patch
---

Signal the session workflow right away when an internal update (child result, Agent message, media result) joins a wake revision that has not been delivered yet, such as the future-dated `wait_for_input` deadline. The update still coalesces into that revision. Before this change it waited for the periodic dispatcher tick, which delayed a waiting parent's pickup of a child result by up to 10 s.
