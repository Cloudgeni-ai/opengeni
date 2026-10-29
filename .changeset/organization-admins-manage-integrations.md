---
"@opengeni/api-router": minor
---

Organization admins, like the owner, now manage the organization's webhooks and credential provider, and see and revoke everyone's personal API keys and connected agents in their organization. The rule is the organization's owner or an admin signed in as themselves (or a verified agent acting as them with `account:admin` in its access); being an admin of one organization grants nothing in another. Organization settings show the Developer page and its integrations to admins exactly when the server allows them. Organization API keys and service accounts are unchanged.
