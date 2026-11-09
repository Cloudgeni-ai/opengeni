---
"@opengeni/api-router": patch
---

Gmail, Google Calendar and Google Drive logins now recognise a Google account by Google's account ID, not only its email. After an account's address changes (for example a renamed Workspace user or domain), Reconnect works on the existing login instead of failing with "Sign in to the same account", and the login shows the new address. An address now used by a different Google account is no longer treated as the same account. Logins saved earlier pick up the ID the next time they are signed in to: when the address matches, or for Gmail when the old address is still one of the account's accepted send-as addresses. The Google consent screen is unchanged.
