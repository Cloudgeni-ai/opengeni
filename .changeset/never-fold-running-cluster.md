---
"@opengeni/react": patch
"@opengeni/events": patch
---

Fresh-eyes review fixes: sandbox command output uses its canonical `chunk` wire field end-to-end — the projection and the compact coalescer previously read only legacy `text`/`output`, so compact history windows dropped terminal output entirely (and the resume cursor skipped the raw events that carried it); coalesced sandbox runs now also break on stream and commandId so stdout/stderr never merge. Live-cluster folding is re-based on the true invariants: a cluster with running/streaming items never folds, and folding happens only when the NEXT group is agent progress (activity/turn/narration) — so a pending queued message or an approval pause no longer folds the work the reader needs in view.
