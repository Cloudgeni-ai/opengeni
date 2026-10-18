---
"@opengeni/browserd": patch
"@opengeni/api-router": patch
---

Lost browsers recover in more cases and refuse clearly otherwise. A browser whose controller died is relaunched in its own directory even when the agent-browser daemon that launched it is still running: that daemon is identified from its own environment and stopped. macOS controllers now prove that nothing runs a profile from one full process listing, so lost browsers there resume like on Linux. Daemons whose browser is gone are stopped when a session ends and when a controller starts, instead of running forever. A recovery proof that cannot be completed is a 409 with its reason instead of an internal error, and a lost browser's preserved working copy can be inspected and adopted through the controller generation that owns it.
