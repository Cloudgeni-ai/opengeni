---
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/api-router": patch
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Members of an organization can now see who else is in it, by name. `GET /v1/organizations/:organizationId/member-names` (SDK `listOrganizationMemberNames`) returns `{ available, members }`, where each member has only a membership `id`, a display `name` (or `null`) and `you`. Any active owner, admin or member acting as themselves can call it; outsiders, suspended and offboarded people get `403`. Product users (`external_user:`), services and keys are never listed, and emails, roles, status, invitations, workspace access and usage stay with the owner and admin directory (`/members`), which is unchanged. In the console, a member's People settings page now lists everyone by name with a search. Migration 1211 creates the `list_organization_member_names_v1` database function without granting it to the runtime yet, as the two-release rule requires; until a later migration grants it, the route answers `available: false` and the People page says only owners and admins can see who is in the organization.
