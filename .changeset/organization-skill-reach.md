---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

An organization Skill works in the workspaces its organization picks: every shared workspace or chosen ones, plus a switch for members' Personal workspaces. Existing Skills keep working everywhere. Agents in a workspace it doesn't work in stop seeing it from their next turn; people who can change it still find it there, marked "Not used here". New `PUT /v1/workspaces/:workspaceId/skills/content/:skillId/reach` and SDK `updateSkillReach`; Skill records carry `reach` and `availableHere`.
