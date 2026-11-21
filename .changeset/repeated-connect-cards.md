---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

When an agent asks for the same connection more than once, in one turn or across turns, only the newest card stays a full card; earlier ones become one short line, as Connected Machine cards already did. `AuthNeededItem.askedAgainLater` now applies to every connection card.
