---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Deciding several parallel tool approvals now just works. A decision for an approval that is still undecided is accepted while the turn resumes from a sibling decision, instead of failing with "no unhandled approval is pending". One resume applies every decision made before it, so each decision no longer restarts the turn and asks the rest again, and an already decided approval is never asked again. Deciding the same approval twice is accepted once, and a real conflict says why: already approved or declined, already finished, or the turn ended. The chat, the sub-session card, the phone app and the embedded chat keep the undecided approvals up and decidable while the turn resumes. `approvalsDecidable(status)` is exported from `@opengeni/react` and `@opengeni/react/session`.
