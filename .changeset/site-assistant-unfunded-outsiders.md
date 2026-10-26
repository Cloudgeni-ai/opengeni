---
"@opengeni/contracts": patch
---

A published Site whose workspace has no credits for its assistant's model no longer shows guests and other people outside the workspace a purchase prompt. Their conversation start or message is refused with `not_available_for_viewer` (`feature: "agent"`, `reason: "no_credits"`) and the message "This Site's assistant isn't available right now", `site.capabilities.agent` is false for them, and the publication reports the new readiness warning `agent_model_outside_no_credits` so the owner knows to add credits or choose a covered model. Workspace members keep the ordinary credit refusal.
