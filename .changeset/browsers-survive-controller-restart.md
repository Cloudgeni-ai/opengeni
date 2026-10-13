---
"@opengeni/browserd": patch
---

Agent updates and controller restarts no longer close managed browsers. Graceful browserd shutdown now detaches from a browser with a durable working runtime instead of closing it, so its tabs and unsaved page state (open editors, half-filled forms) stay live, and the next controller adopts the same process on its next request. Previously, shutdown closed Chrome and recovery relaunched it in the same profile: cookies and storage survived, but live page state was lost. Live reattachment now also works for headed browsers, for a launcher from an earlier agent release, and for a browser whose launcher was killed with a stopped service. A stale launcher record whose PID now names an unrelated process is still refused.
