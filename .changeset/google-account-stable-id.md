---
"@opengeni/api-router": patch
---

Gmail, Google Calendar and Google Drive logins now recognise a Google account by Google's account ID, not only its email. After an account's address changes (for example a renamed Workspace user or domain), Reconnect works on the existing login instead of failing with "Sign in to the same account", and the login shows the new address. An address now used by a different Google account is no longer treated as the same account. To get the ID, these sign-ins also ask Google for `openid`. A login saved earlier records the ID the next time it is reconnected with the same address; one whose address changed before that still has to be removed and added again.
