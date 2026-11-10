---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

Approval cards now read in the host's words and language. A saved review carries codes beside its English text: `reasonCode` for why it asks or is blocked, `approveLabelCode` when the button is the plain "Approve action" or "Allow", `toolName` for the action, and per field the argument it stands for (`key`) and a plain yes or no (`booleanValue`). The card, the approval list and the step in the chat word these through the host's `messages`: `approvalSurface.approveAction` and `approvalSurface.allow` for the button, `toolActionReview.reason.*` for the reason, `toolActionReview.yes` and `.no` for yes or no values, and new host keys to name a connector's actions and fields the same way as `connectService.<id>.name`: `toolAction.<toolName>.title`, `toolAction.<toolName>.field.<argument>` and, for every tool, `toolField.<argument>`. Without host words nothing changes.
