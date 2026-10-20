---
"@opengeni/db": patch
---

AI chats from "Anyone with the link" visitors on a Site published from a personal workspace work again. They used to fail with a database permission error as soon as the turn started, before the model was called, because learning for a personal workspace assumed a signed-in person. Work with no initiating person in a personal workspace now uses the workspace learning destination, as it already does in shared workspaces, never reaches the owner's personal layer, and saves no Knowledge, Skills or instructions there.
