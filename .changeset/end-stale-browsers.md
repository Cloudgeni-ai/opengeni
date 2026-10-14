---
"@opengeni/browserd": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Browsers whose runtime or machine is gone can be ended. Previously such a browser could never be closed, so people kept seeing dead browsers:

- After the agent restarted, ending a managed browser it had launched was refused with "Current browser is unavailable; its browser record and recovery state are preserved". An explicit end of the exact bound controller generation now retires it on the machine: any browser still running that session's private profile is stopped by verified identity (a reused PID is never signalled), the working runtime is retired and the session's local state is removed. Recovery state of any other generation stays preserved.
- Ending a browser on a removed (revoked) Connected Machine, or a browser in a person's own Chrome whose device is disconnected or whose machine was removed, failed (for example "sandbox not available" or "Attached browser is disconnected"). It now completes in the control plane under the bound controller generation, so that controller stays fenced and the browser's private checkpoint goes to normal retention. Tabs a Chrome browser opened stay with the person as ordinary tabs. A managed browser on a machine that is only offline still waits for the machine, which holds its process and profile.

`interactionControllerGone` (db) decides this through the viewer's owner-aware machine listing, so a machine hidden from a person is never judged gone.
