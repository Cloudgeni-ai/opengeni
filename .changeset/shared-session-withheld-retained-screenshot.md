---
"@opengeni/worker-bundle": patch
---

In shared sessions, a retained screenshot that another participant kept privately no longer fails the next participant's turn with "unavailable: deleted" before the model runs. The image is replaced in the model's view with the same neutral receipt used for unavailable history attachments ("not available to the current requester", no download instruction), and the turn proceeds. The file-authority boundary is unchanged, and really deleted, expired or corrupt screenshots still fail as before.
