---
"@opengeni/worker-bundle": patch
---

A chat whose active sandbox is a Connected Machine always starts its turn on that machine. Turn start used to treat a failed read of the chat's route (for example while database connections were re-established after a redeploy) as "no machine", so the turn ran setup, credential seeding and file downloads on the chat's managed cloud box and was then discarded. These reads are now retried briefly and, if they still fail, stop the attempt before any box is touched so it is retried.
