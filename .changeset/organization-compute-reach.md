---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"@opengeni/react": minor
---

Organization machines and sandbox environments work in the workspaces the organization's owner or an admin picks: every shared workspace or chosen ones, plus a switch for members' Personal workspaces, with the same "Available in" picker as the organization's model keys and connectors. The workspace a machine was connected from, or a sandbox environment was made in, always has it, and existing ones keep working everywhere they did. New `PUT .../machines/:enrollmentId/reach` and `PUT .../rigs/:rigId/reach` routes, `updateMachineReach` and `updateRigReach` in the SDK, and `reach` on organization machines and sandbox environments.

Fixes organization sandbox environments failing in chats outside the workspace they were made in ("query returned no rows" when a turn started).

A sandbox environment's page offers changes to an organization sandbox environment only to the organization's owner or an admin, as the API requires. Before, members who manage sandbox environments saw actions there that were then refused.
