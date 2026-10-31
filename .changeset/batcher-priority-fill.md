---
---

Merge batcher: the oldest ready PRs fill the rest of a priority batch, so priority PRs that arrive one at a time no longer each take a round alone. Priority CI or batcher changes still run alone, and priority PRs go unfilled while a failed batch is being split. A failed batch with both priority and other PRs tests its priority PRs alone first.
