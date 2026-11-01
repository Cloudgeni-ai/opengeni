---
"@opengeni/api-router": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/runtime": patch
"@opengeni/sdk": patch
---

Organization admins now manage the organization's Knowledge, documents and their backfills, organization Skills and the preference registry, the company profile and its agent policy, and can list the organization's sessions, as the owner does. Admins can also choose organization documents as the destination for connector syncs (Atlassian, Google Drive, Slack). The rule is "owner or admin of this organization", proven by the signed-in human session; admins don't get `account:admin`, so billing, roles, ownership and deleting the organization stay owner-only, and admin rights in one organization never apply to another. Agent turns started by an admin can propose and confirm company-profile changes (migration 1096). The web app shows these controls to admins exactly when the server allows them. New `@opengeni/core` helpers: `holdsOrganizationAdministration`, `authorizationHoldsOrganizationAdministration` and `requireOrganizationAdministrationStamp`.
