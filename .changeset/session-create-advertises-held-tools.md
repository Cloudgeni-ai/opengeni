---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
---

`session_create` now advertises in `firstPartyMcpTools` only the deployment-allowed tools the calling session actually holds, instead of the whole first-party catalog, and its description tells agents to omit the field in almost every case. Its `agent`, `goal` and `machineTarget` object inputs also accept the same object sent as a JSON string, validated exactly like the object form; anything else is still rejected.

Creating a session with first-party tools the deployment disables now names every such tool and the allowed set, instead of only the first one, and checks the caller's own tool names before legacy aliases expand them. A capability unavailable because its tools are not allowed now names those tools. `notify_user` results report `undeliveredReason: "no_human_recipient"` when no one was notified.
