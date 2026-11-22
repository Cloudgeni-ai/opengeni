---
"@opengeni/core": patch
"@opengeni/contracts": patch
---

Connecting a coding agent starts in the organization you last worked in, with everyday work selected (chats, files, knowledge, apps and their data, automations, and using secrets, GitHub and sandbox environments; it never manages people, keys, billing, connections, capabilities, machines or terminals, controls live screens, and never reads secret values), shown as Custom so every permission stays visible. The permission list has an Apps and artifacts group, and read only connections can query app data. App data a connected agent writes is recorded as that connected agent (`agent:connection:<id>`) instead of as the person; the records still belong to the person, and app change events for those writes now show writer `agent` instead of `user`.
