---
"@opengeni/api-router": minor
"@opengeni/db": minor
"@opengeni/react": patch
"@opengeni/sdk": minor
---

The sidebar now names chat creators the way people know them. Grouped or sorted by creator, a person's group shows their current workspace name (their email when they have no name, and the name saved with the chat when they have left the workspace), in its own capitalization rather than uppercase. An API key shows its name with a small "API key" hint, and other services show a "Service" hint; raw subject ids never appear. Row chips, hover cards, ⌘K and screen-reader labels use the same names, and an API key never gets a person's initials chip.

An API key's chats form one group even when older chats recorded the key as a subject and newer ones as a service. Names that two creators share are told apart by the name saved with their chats, or by a number.

The session list API accepts `createdBySubjectId` without `createdByKind`, matching every session that subject created whichever kind it was recorded as; `createdByKind` alone is still rejected. The SDK's `listSessionPage` `createdBy.kind` is now optional to match, and `@opengeni/db` session list filters accept a creator without a kind. Requests that send both keep their exact behaviour.
