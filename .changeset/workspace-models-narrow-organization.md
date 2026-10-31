---
"@opengeni/db": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

An organization's Allowed models list is now a ceiling for every workspace in it. A workspace's own list only narrows it: a model runs only when both lists allow its provider and both allow the model, so a workspace that allows every model allows exactly what its organization allows, and listing a model the organization doesn't allow never lets it run. Before, a workspace's own list replaced the organization's. The combined policy applies at the API edges, the omitted-model default, goal admission, subscription placement and failover, and the worker's model gate. The workspace model catalog adds `organizationAllowed` (false when the organization's list rules a model out, omitted when it allows every model), and the Allowed models form shows those models locked. `GET /v1/workspaces/:workspaceId/model-policy` still returns the workspace's own lists as saved, next to the `organization` lists.
