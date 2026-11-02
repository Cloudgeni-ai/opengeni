---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

The verified owner of a Personal workspace, acting as themselves, can now change the model account settings their organization has not locked (rotation, fallback, switching models and a provider's source), as a shared workspace's admins can. Locked settings still win. The database admits the change only for the owner's own row with an owner declaration the API sets after verifying the owner, so colleagues, organization admins and delegated tokens are still refused in someone else's Personal workspace. The web app shows these controls in Personal exactly when the server allows them, and the organization's settings say that unlocked rules can also be changed in Personal workspaces.
