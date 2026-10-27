---
"@opengeni/contracts": patch
---

A published Site whose workspace can't pay for its assistant no longer shows guests and other people outside the workspace the owner's purchase prompt. Their conversation start or message is refused with `not_available_for_viewer` (`feature: "agent"`) and the message "This Site's assistant isn't available right now", with `reason: "no_credits"` when the workspace has no credits for the model or `reason: "allowance_exhausted"` when its usage allowance is used up. `site.capabilities.agent` is false for them, and the publication reports the new readiness warning `agent_model_outside_no_credits` or `agent_model_outside_allowance_used` so the owner knows what to change. Workspace members keep the ordinary refusals; core's no-credits refusal (`payment_required`) now also carries `details.code: "insufficient_credits"`.
