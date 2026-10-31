---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
---

An organization's credential provider can now also serve its members' Personal workspaces. Organization settings → Developer → credential provider has a "Personal workspaces" checkbox, off by default, so existing providers keep their current reach. Through the API it is `allowPersonalWorkspaces` on `PUT /v1/organizations/:organizationId/credential-provider`; like every field there it is replaced on each PUT, so leaving it out turns it off.

The workspace filter still selects shared workspaces only, and the checkbox alone decides Personal workspaces. A Personal workspace's own provider still wins over the organization's. Requests from a Personal workspace carry its workspace ID and, for turns, the member as `initiatingHuman`. Organization webhooks still never cover Personal workspaces, because they would send a member's private chat activity to the organization's endpoint.
