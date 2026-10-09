---
"@opengeni/db": patch
---

The checkpoint staleness alert no longer misses unsaved sandbox changes. `opengeni_sandbox_checkpoint_staleness` and `opengeni_sandbox_checkpoint_age_max_seconds` checked only the newest captured write for a settlement after the checkpoint, so a long-running background command that outlived a newer, already-settled write left the box looking clean. Any captured write on the box that settled after the checkpoint now counts, aged from that checkpoint, using a new index on settled writes so the probe stays cheap. An attached desktop or terminal tab, or a browser or computer controller, can change files without being recorded, so it now counts too, including one that was attached and detached again since the last save, aged from the later of the checkpoint and the first attach.
