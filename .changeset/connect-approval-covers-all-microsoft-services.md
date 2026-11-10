---
"@opengeni/contracts": patch
"@opengeni/connect": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
---

One IT approval now covers every Microsoft service the app offers in the workspace. The organization admin-consent link requests the combined permissions of all available Microsoft connections that share the same app registration (for example Outlook Mail, Outlook Calendar and OneDrive together), so a company does not need a second approval when someone adds another Microsoft service later. The Microsoft sign-in step now also carries this link as `nextAction.organizationApprovalUrl`, and the connect UI uses it for the approval help, including when a sign-in never came back.
