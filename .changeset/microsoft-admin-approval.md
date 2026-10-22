---
"@opengeni/react": patch
---

Connecting Outlook or OneDrive no longer dead-ends when a Microsoft 365 organization requires an administrator to approve the app. When Microsoft refuses or the person returns from its "Need admin approval" page, the connect dialog explains that a Microsoft 365 admin can approve the app for everyone and offers an admin approval link to open or copy. The administrator lands on a short confirmation page, and people connect again afterwards. The connect attempt's error message carries the same link, so agents can pass it on.
