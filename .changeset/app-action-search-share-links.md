---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
---

App action search now matches a verb and its noun, so "invite" finds the organization invitation actions (it found nothing before). Adding a workspace member, inviting someone to the organization and changing who in the workspace can see a chat now carry plain descriptions that point to `createSessionShareLink` for letting one person, such as family or a friend, read one chat.

The bundled product-help guide no longer says that sharing a chat needs the other person in the workspace. Letting someone read a chat now uses a share link, explained in one plain sentence, and working together in the same chats keeps the invite path.
