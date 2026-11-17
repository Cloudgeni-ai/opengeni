---
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Unpaid sandboxes are now bounded across the whole fleet, not only per organization and person, so many new accounts cannot add up to a large fleet. All unpaid organizations together share a running-box cap (default 40) and a daily box-time budget (default 300 box-hours per UTC day); an unpaid organization in its first 24 hours runs one box and gets 6 box-hours; and when more than 50 boxes of every plan are warm, unpaid boxes are capped at 15 until the warm count stays below 40 for 15 minutes. A refused start says the shared free capacity is busy (`sandbox_capacity_unpaid_busy`); an agent turn fails with that message instead of retrying, and a turn already on a running box keeps working. Unpaid admissions fail closed when the fleet cannot be read. Paid, Enterprise, host-provisioned and credit-buying organizations are never counted or limited.

Values are runtime settings in `OPENGENI_SANDBOX_FLEET_LIMITS_JSON`, separate from the plan limits; unknown fields are ignored, so it can be set during a rolling deploy. The reaper records the fleet's state as metrics, with a page while the daily budget is spent. The running caps (including the pressure cap) and the daily budget read a new database function (migration 1485) that a later release grants; until then the young-organization limits apply, and pressure only with a cap of 0.
