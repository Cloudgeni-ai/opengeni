---
---

Merge batcher: the oldest ready PRs fill the rest of a priority batch, so priority PRs that arrive one at a time no longer each take a round alone. Priority CI or batcher changes still run alone, and PRs in a failed batch's halves keep their place there.
