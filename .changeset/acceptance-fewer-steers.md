---
---

Release live acceptance now runs 20 real Steer cancellations plus the hostile Pause instead of 100. Each Steer costs two real model turns in one session whose history keeps growing, so 100 Steers could use up a whole weekly model-subscription quota in one run and leave the next release unable to pass its funding check. The 100 capture API reads and fresh-browser navigations stay at 100, because they use no model. `--steer-repetitions` (at least 20) sets the Steer count separately from `--repetitions`, the release bundle verifier requires at least 21 control samples instead of 100 for the cancellation budget, and the default control-phase time budget drops from 75 to 25 minutes to match.
