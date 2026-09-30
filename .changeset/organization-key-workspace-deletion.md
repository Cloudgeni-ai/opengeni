---
"@opengeni/api-router": patch
"@opengeni/sdk": patch
---

`deleteOrganizationWorkspace` (`DELETE /v1/organizations/:organizationId/workspaces/:workspaceId`)
now accepts an organization API key with `workspace:admin`, so an integrating
backend can delete the organization workspaces it provisions with
`ensureWorkspace`. It previously answered 401 "managed human session required"
to every key. Personal workspaces stay undeletable by keys, a read key gets 403,
and the existing quiescence rules still apply.
