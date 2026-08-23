---
"@opengeni/core": minor
"@opengeni/react": minor
---

`requireSessionAuthorization` denies `session.approval.write` to every agent attempt on every surface: tool approvals stay human-only, while structured human input (`session.human_input.write`) remains answerable by a live attempt. The React queue chrome and timeline label the new child lifecycle notice kinds (`child_requires_action`, `child_requires_action_resolved`, `child_paused`, `child_waiting_capacity`, `child_progress`) instead of dropping them.
