---
"@opengeni/api-router": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
---

Chats created with an API key are now labelled by the key's name with an "API key" hint in the sidebar's creator groups and hover cards (for example "Codex operator 2026-09-11 · API key") instead of a raw principal id, and other services show a "Service" hint; a key or service without a name shows just "API key" or "Service", never an id. An API key's chats form one group (people and services keep their exact frozen kind) even when older chats recorded the key as a subject and newer ones as a service, keys that share a name are told apart by a number, and an API key never gets a person's initials chip. How people are shown is unchanged.

The session list API accepts `createdBySubjectId` without `createdByKind`, matching every session that subject created whichever kind it was recorded as; `createdByKind` alone is still rejected. The SDK's `listSessionPage` `createdBy.kind` is now optional to match, and `@opengeni/db` session list filters accept a creator without a kind. Requests that send both keep their exact behaviour.
