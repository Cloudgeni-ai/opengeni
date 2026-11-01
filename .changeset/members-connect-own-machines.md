---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
---

An organization's owners and admins can now choose whether members connect machines of their own. Organization settings → Security & data has a "Members connect their own machines" switch, on by default. Through the API it is `membersConnectOwnMachines` on `GET`/`PATCH /v1/organizations/:organizationId/privacy-settings`, changed by the same owners, admins and administration-capable organization keys as the other privacy choices.

Off, only the organization's owners and admins connect a new Only me machine, or any machine in a Personal workspace. Workspace permissions don't lift it. Minting a connect command and approving a pairing code answer `403` with a plain sentence; declining a code still works. Shared-workspace and organization machines keep their existing rules, and machines already connected keep working and stay their owners' to change or remove.

`GET /v1/workspaces/:workspaceId/machines` now reports `canConnectOwnMachine` for a person (omitted for an agent listing its own chat and by older servers), and `useWorkspaceMachines` exposes it. `ConnectMachineDialog` takes a `canConnectOwnMachine` prop: false disables Only me (and This workspace in a Personal workspace), skips the this-computer path, and explains who can connect when nothing is left.
