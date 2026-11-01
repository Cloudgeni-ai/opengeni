---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

Organization settings › Shared says where each organization machine, sandbox environment, Skill and Knowledge works, instead of saying they work in every workspace. Since an organization picks where each works, organization owners and admins now see every organization machine and sandbox environment wherever it works, including ones that don't work in the workspace the page is opened from, each with where it works and a workspace to open it in. The Skills row says how many of the organization's Skills don't work here. Organization owners and admins manage them, and the page now says admins too. Available here and Shared call rigs "Sandbox environment", as the rest of the app does.

New: `GET /v1/workspaces/:workspaceId/organization-machines` (`enrollments:read`) and `GET /v1/workspaces/:workspaceId/organization-rigs` (`rigs:use`) list every organization machine or sandbox environment wherever it works, for an organization owner or admin, with its reach, and `complete: false` while the server can list only the ones that work in the requested workspace; the SDK's `listOrganizationMachines` and `listOrganizationRigs`. Migration 1224 creates their routine with the runtime grant withheld for one release.
