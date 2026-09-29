---
"@opengeni/contracts": patch
"@opengeni/worker-bundle": patch
"@opengeni/sdk": patch
---

Every `session.requiresAction` approval entry now carries the same top-level `id`, `name`, and `arguments`, whether it is the first pause of a turn or a later one after a decision. `id` is the `approvalId` that `sendApprovalDecision` accepts (the pending tool call id). Historical fields (`rawItem`, `raw`) remain for compatibility. The SDK exports this as `SessionApprovalRequest`.
