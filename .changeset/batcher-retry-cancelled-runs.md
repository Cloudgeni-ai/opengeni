---
---

Merge batcher: a batch run that GitHub cancelled, for example a job past its time limit during a GitHub outage, is retried instead of bisected, up to three attempts. Bisecting it tested every half again for a failure none of its PRs caused. A real failure next to the cancelled run, or a run cancelled on every attempt, is still judged as before.
