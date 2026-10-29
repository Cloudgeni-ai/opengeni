---
"@opengeni/api-router": minor
"@opengeni/core": patch
"@opengeni/react": minor
---

Organization admins, like the owner, now manage the organization's vaults, organization-owned 1Password and other vault-provider connections, organization machines (approving, removing, command policy, screen control and agent updates) and organization Sandbox Environments. The rule is the organization's owner or an admin signed in as themselves, or a credential that holds `account:admin`; being an admin of one organization grants nothing in another. The Secrets, Sandbox Environments, device approval and machine pages show these controls exactly when the server allows them; device approval offers organization scope only to someone who also manages enrollments in that workspace.
