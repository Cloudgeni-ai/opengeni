---
"@opengeni/api-router": minor
"@opengeni/db": patch
---

Organization admins, like the owner, now manage the organization's webhooks and credential provider, and see and revoke everyone's personal API keys and connected agents in their organization. The rule is the organization's owner or an admin signed in as themselves (or a verified agent acting as them with `account:admin` in its access); being an admin of one organization grants nothing in another. Organization settings show the Developer page and its integrations to admins exactly when the server allows them.

Organization admins also manage the organization's API keys and service accounts at member level: they see all of them, and create, change or revoke only keys that can't manage people, keys or billing and aren't held by an admin service account, and change or delete only member service accounts. Only the owner makes a service account an admin or manages owner-level keys. The Create API key page offers admins Read only and Custom (without administration permissions) and only member service accounts, and hides Revoke and editing where the server would refuse. `@opengeni/db` exports `effectiveKeyPermissions`.
