---
"@opengeni/react": patch
---

In a chat shared with the workspace, the note about your own logins is now one quiet line above the composer ("Using your Gmail, Slack and Atlassian"). It opens a menu that says the logins work for your messages and that people in the workspace see what the agent does with them, with one Stop item per login. An account connected more than once is listed once, and Stop turns off every connection of it here. `OwnLoginInUse` now carries `accounts`, `label` and `connector`, `OwnLoginsSharedHeadsUp`'s `onStop` receives the account's connections, and `stopOwnLoginHere` became `stopOwnLoginsHere`.
