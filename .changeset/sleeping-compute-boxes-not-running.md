---
"@opengeni/db": patch
---

Sleeping compute sandboxes no longer count as running boxes. Compute leases stay warm while their sandbox sleeps, so an organization's idle chats could fill its running-box limit and park every new chat with `organization_sandbox_capacity`. The organization and person running-box limits, viewer-only limits (organization-wide and per workspace), the unpaid fleet cap and fleet pressure now leave out a compute lease whose sandbox is asleep. Waking a sleeping box that no turn holds is admitted like starting a new one, so the limits still bound how many boxes run. Migration 1573 grants the runtime the managed warm box count, so fleet pressure no longer counts self-hosted or sleeping boxes.
