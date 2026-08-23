---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/react": minor
---

Surface why a goal is not pursuing and how long children have waited for a human. `Session.treeStats` gains optional `attentionSince` (earliest `requires_action` entry among the counted attention descendants), `Session` gains optional `requiresActionSince` on list and lineage reads, and the goal continuation projection gains optional `holdReason` for a `held_for_input` hold. `SessionChrome`'s goal pill spells out the pause reason ("Paused · cap" / "budget" / "by you" / "agent"), explains an idle-backoff check time and an agent `goal_wait` hold, and exports `sessionChromeGoalPillLabel` / `sessionChromeGoalPillExplanation`.
