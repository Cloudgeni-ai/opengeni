---
"@opengeni/core": patch
"@opengeni/contracts": patch
---

Connecting a coding agent starts in the organization you last worked in, with everyday work selected (chats, files, knowledge, apps and their data, automations, and using secrets, GitHub and machines; never people, keys, billing, connections, capabilities, terminals or secret values), shown as Custom so every permission stays visible. The permission list has an Apps group for opening apps and managing their data. App data a connected agent writes is recorded as that connected agent (`agent:connection:<id>`) instead of as the person; the records still belong to the person, and app change events for those writes now show writer `agent` instead of `user`.
