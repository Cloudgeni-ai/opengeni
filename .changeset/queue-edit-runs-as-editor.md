---
"@opengeni/db": patch
"@opengeni/core": patch
---

Editing someone else's queued message now makes it the editor's own message. Before, resubmitting the edit copied the original sender's identity, own (Only me) logins, account choices and model allowance, so another member could run their own words through the sender's personal accounts, and a workspace API key's edit failed with a server error. The edit now runs as the editor, with the editor's own logins and allowance; the sender's own edits are unchanged.
