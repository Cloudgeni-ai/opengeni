---
"@opengeni/contracts": patch
"@opengeni/react": patch
---

Every workspace member can now connect their own computer. A signed-in member who can see the workspace's machines connects an "Only me" machine from the Machines page, a chat's machine card or the pairing-code page, and changes, updates or removes their own "Only me" machines. Sharing a machine with the whole workspace still needs a workspace admin, and the whole organization an organization admin; for a member, "This workspace" shows disabled with the reason. Keys, agents, services and credentials acting for someone keep needing `enrollments:manage`, and a refusal is now a plain sentence instead of "missing permission: enrollments:manage". In `@opengeni/react`, `useWorkspaceMachines` adds `canConnect` and `canManageMachine(machine)`, `ConnectMachineDialog` takes `canShareWithWorkspace`, `EnrollmentConsent` takes `allowWorkspaceScope`, and `MachinesDashboard` takes `canUpdateMachine`. The action catalog lists `enrollments:read` as the first permission these routes check.
