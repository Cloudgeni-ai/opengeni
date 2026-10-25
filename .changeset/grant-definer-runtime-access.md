---
"@opengeni/db": patch
---

Migration 0947 grants the runtime role EXECUTE on the event trigger, recording recovery, MCP Events and event source feed `SECURITY DEFINER` routines, and DML on `event_ingress_routes`, which 0937 withheld for one release. Readiness and provisioning now require them, so stalled-recording recovery and event intake retention run again instead of being denied. The recording retention inventory from 0946 stays withheld until its own follow-up release.
