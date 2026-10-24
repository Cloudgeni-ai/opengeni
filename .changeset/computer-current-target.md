---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

Computer tools that omit targetId now keep working in the window the computer was last observed or acted on in, also in a later turn. The remembered window lived for one turn attempt, so the first such call of a follow-up turn ("do the rest") failed with computer_target_required and the agent had to resend both identifiers. A computer's target list now marks that window with `current: true`, and a call that omits targetId before its attempt used a window of the computer uses it. A window this attempt used still wins, and when the computer has no current window the call still asks for targetId.
