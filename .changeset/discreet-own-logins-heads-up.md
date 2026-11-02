---
"@opengeni/react": patch
---

In a chat shared with the workspace, the note about your own logins is now one quiet line above the composer, "N personal connections in this chat", counting the accounts that are on. It opens a menu that says people in the workspace see what the agent does with them, with one switch per account; turning one off stops it for your messages in this workspace, and it stays in the menu so you can turn it back on. Many accounts scroll. An account connected more than once is listed once, and its switch covers every connection of it. `OwnLoginInUse` is now `{ key, serverId, accounts, label }`; `OwnLoginsSharedHeadsUp` takes `onChange(login, on)` and an optional `logoFor` instead of `onStop`; `stopOwnLoginHere` became `stopOwnLoginsHere`, and `turnOnOwnLoginsHere` was added.
