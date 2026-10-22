---
"@opengeni/browserd": patch
---

An agent update no longer interrupts a browser or computer task between steps. The update used to wait only for the request in flight, so an update that arrived while the agent was thinking about its next step restarted the controller under it, and the agent's next calls failed (draining, upstream unavailable, outcome unknown) until the restart finished. A browser or computer session used in the last three minutes now holds the update back (`browser_recent_use`, `computer_recent_use`); it proceeds once the session has been idle that long or has ended.
