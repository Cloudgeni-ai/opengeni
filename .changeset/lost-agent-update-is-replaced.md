---
"@opengeni/agent-host": patch
"@opengeni/db": patch
---

A Connected Machine update the server stops hearing about no longer stays stuck. An update outlives the connection its request arrived on, since each connection lasts only as long as its five-minute broker credential, but the agent sent its progress through that connection, so progress after it closed could be lost: a failed or still-waiting update could read as `waiting_for_idle` with no blockers for good, on the release promoted back then, and the server never asked again because an accepted update was the agent's to finish. The agent now reports update progress through its current connection. The server treats an unfinished update it has not heard about for 30 minutes (an unanswered request after 10) as lost, and the next heartbeat, or Update now, replaces it with a request for the release promoted now. An agent still carrying the old update refuses it as busy updating and is asked again later. `beginEnrollmentAgentUpdate` takes an optional `replaceUnfinishedBefore` for this.
