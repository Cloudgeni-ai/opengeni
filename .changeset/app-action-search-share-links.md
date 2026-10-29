---
"@opengeni/api-router": patch
---

App action search now matches a verb and its noun, so "invite" finds the organization invitation actions (it found nothing before). Adding a workspace member, inviting someone to the organization and changing who in the workspace can see a chat now carry plain descriptions that point to `createSessionShareLink` for letting one person, such as family or a friend, read one chat.
