---
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/react": patch
---

People with only the personal setup permission (`connections:personal`) can now add a Microsoft Dynamics environment from the chat card and turn it on for their own account. This uses a general rule: an address that belongs to a reviewed sign-in profile can be added this way (`personalSetupEndpointProfile`), and Microsoft Dynamics is currently the only such profile. Anyone with only this permission can add the address and nothing else, and the connection stays personal. Workspace admins can still turn the entry off or remove it, and organizations that keep integration setup for admins still block it.

When an admin needs to confirm with a passkey before turning on an integration, the connect card now asks them to add or confirm a passkey. It used to say that only an admin can turn it on.
