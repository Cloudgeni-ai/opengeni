---
"@opengeni/db": patch
"@opengeni/config": patch
---

Fleet pressure counts only boxes on managed providers. Self-hosted (Connected Machine) boxes cost the deployment nothing and are exempt from the unpaid fleet limits, so they no longer keep pressure engaged. Migration 1492 adds the `opengeni_private.sandbox_fleet_warm_boxes_v1()` count withheld; until a later release grants it, pressure keeps reading every lease. Without subscription plans the reaper no longer reads or reports pressure (`OpenGeniSandboxFleetPressureEngaged`, `opengeni_sandbox_fleet_warm_boxes`), since `none` is not unpaid there; admission still applies pressure to any organization it finds unpaid.
