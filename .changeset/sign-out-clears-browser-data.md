---
"@opengeni/api-router": patch
"@opengeni/react": patch
---

Signing out now leaves nothing of the person's in the tab: unsent messages and answers (in memory and in session storage) and every other per-person Opengeni session-storage entry are cleared, both on sign-out and when the last browser account signs out. Entries that hold nobody's content (reload guards, the "signed in as" notice and an invitation being carried across a change of account) are kept. Successful sign-out responses also send `Clear-Site-Data: "cache"`. Cookies and storage are not cleared that way, so embedding hosts keep their cookies.
