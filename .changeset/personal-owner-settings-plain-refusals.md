---
"@opengeni/core": patch
"@opengeni/db": patch
---

The owner of a Personal workspace can now save its model settings, connect and disconnect its own social accounts and send connector Knowledge to it, like a workspace admin of a shared workspace. Organization-wide settings (Slack and Teams bots, the subscription pool, sharing policies) stay admin-only. API callers who lack a permission now get a plain sentence such as "You don't have permission to manage this workspace's tools and integrations." instead of "missing permission: capabilities:manage"; the permission stays available in the error details, and refusal metrics classify these refusals by permission.
