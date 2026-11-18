---
"@opengeni/db": patch
---

A turn resolves its workspace governance (instruction policies and organization profile) when it starts running instead of when it was accepted. A turn that waited in the session queue or for subscription capacity now runs under the governance activated while it waited. Once a turn has run, its later attempts (recovery, approval, resume) keep that governance, and changes reach the next turn, as before. Migration 1488 changes when the snapshot routines resolve; the model-visible governance block and its text are unchanged.
