---
"@opengeni/db": patch
---

Sleeping compute sandboxes no longer count as running boxes. Compute leases stay warm while their sandbox sleeps, so an organization's idle chats could fill its running-box limit and park every new chat with `organization_sandbox_capacity`. The organization and person running-box limits, viewer-only limits, the unpaid fleet cap and fleet pressure now leave out a compute lease whose sandbox is asleep.
