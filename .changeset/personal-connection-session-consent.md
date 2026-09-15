---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
---

Allow managed users to authorize their personal connections for an exact session without enabling the separate private-session product rollout. Expose consent visibility and authority epoch through Session.connectionContext, and retain ownership, shared-results acknowledgement, accepted-turn and live revocation checks. Standing shared-workspace Connection grants use the same independent consent lifecycle; standing private-context grants and other personal resources keep their activation gate.
