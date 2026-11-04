---
"@opengeni/worker-bundle": patch
---

A Steer sent just as a running turn finished a tool call now takes over within moments. The turn checks for a waiting Steer before each model request, and that check runs alongside slower ones; when the Steer arrived while they were still running, the turn could treat its own earlier read as proof that the Steer had been withdrawn, send one more model request that could no longer be cut short, and leave the Steer waiting for that whole extra step (often 10 seconds or more when the step was a long command wait). The turn now reads again before it concludes the Steer is gone, and a restarted Steer watch checks at once instead of at its next 10-second safety recheck.
