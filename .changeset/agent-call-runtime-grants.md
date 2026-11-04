---
"@opengeni/db": patch
---

Grant the agent-call and native push v2 routines withheld by migration 1107. Readiness now requires these grants, phones retain opted-in call rules, and calls use the VoIP-aware push functions without probing privileges or falling back to v1. Existing v1 SQL routines remain available during rolling deployments.
