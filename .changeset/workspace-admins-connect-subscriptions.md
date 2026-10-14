---
"@opengeni/db": minor
"@opengeni/api-router": patch
---

A shared workspace's administrators can now connect subscription accounts (Codex, Claude, SuperGrok and API keys) for their own workspace without being organization administrators, and remove them again. The account belongs to the organization, serves only that workspace, never reaches Personal workspaces, and stays visible to organization owners and admins, who alone widen its scope. Once an account serves another workspace, only an organization administrator can remove it. Rolling migration 0777 adds the matching insert and read policies and lets the disconnect routine accept the managing workspace's administrator for the workspace's own account. The Models page now offers Codex to workspace administrators and says who the account is for.
