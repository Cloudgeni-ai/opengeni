---
---

Merge batcher: an unset window or CI start timeout now falls back to its intended default (3 minutes and 10 minutes) instead of the same number read as milliseconds. With a 0.6-second start timeout, a batch built right after a landing in the same pass was abandoned before GitHub registered its CI run and rebuilt again and again, leaving a queued CI run behind for each copy.
