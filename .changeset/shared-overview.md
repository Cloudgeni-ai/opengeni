---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"@opengeni/react": patch
---

Organization settings has a Shared page for owners and admins: everything the organization shares with its workspaces and where each works. Models and their payers link to Models; the organization's machines, rigs, Skills and Knowledge are listed as working in every workspace, Personal workspaces included; each organization vault says where it works and opens in a workspace the viewer can reach. New: `GET /v1/workspaces/:workspaceId/organization-vaults` (`account:admin` and `secrets:list`) lists every organization vault wherever it works, with `complete: false` while the server can list only the ones that work in the requested workspace, and the SDK's `listOrganizationVaults`. Migration 1218 creates its routine with the runtime grant withheld for one release. `OrganizationAdminSection` gains `"shared"`.
