---
"@opengeni/contracts": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
---

Connecting a Microsoft work account (Outlook Mail, Outlook Calendar and other Microsoft Graph connections) no longer ends in a generic failure when the person's organization requires an admin to approve the app. When Microsoft returns a consent error (AADSTS65001, AADSTS90094, `consent_required`, `access_denied`), the connect card and setup dialog explain that their IT must approve the app once, with an organization-wide admin-consent link to copy or open and a ready-made message for IT. A sign-in that never came back (the person stayed on Microsoft's "Need admin approval" page or closed it) is remembered in the browser, and the same help appears the next time they open that connection. All wording comes from `connectSetup.*` messages (`organizationApprovalRequiredTitle`, `itMessageWithLink`, `copyMessageForIt` and others), so host apps can replace it through `messages` on `OpenGeniProvider` or `OpenGeniMessagesProvider`. The admin-consent result page now also works for approvals returning through `/v1/integrations/oauth/callback`.
