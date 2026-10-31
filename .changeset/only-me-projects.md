---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"@opengeni/react": minor
"@opengeni/runtime": patch
---

Projects can be Only me, like chats. `Channel.visibility` is `workspace` (seen by everyone in the workspace, as every project was before) or `private`: seen only by its owner and agent turns acting for them, holding only that owner's own Only me chats and Sites, with a name that is unique only among their Only me projects. `CreateChannelRequest.visibility` chooses it; omitted, a person's project is shared and an agent's `project_create` follows its chat, Only me when made in an Only me chat. Its owner shares it with `UpdateChannelRequest.visibility: "workspace"`, from a signed-in person only; nothing makes a shared project Only me. Filing another kind of chat or Site in an Only me project is refused with 422, and a chat or Site that later becomes shared leaves it. In the app, New project offers "Who can see it" where Only me chats are allowed, the sidebar marks Only me projects with a lock and offers "Share with workspace…", and choosing an Only me project for a new chat makes that chat Only me. Rolling migration 1161.
