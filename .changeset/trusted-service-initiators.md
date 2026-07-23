---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

Let trusted embedding hosts sign a service-only causal initiator separately
from the delegated subject that authorizes a create, Send, or Steer command.
Freeze that service and its non-secret provenance onto the new session/turn,
while rejecting human impersonation, exact agent-attempt replacement, reserved
lineage fields, the legacy migration sentinel, and oversized provenance.
Service-provenance HTTP tokens use a prefix-bound `ogd2_` envelope so older
rolling-deploy verifiers fail closed instead of silently stripping attribution.
