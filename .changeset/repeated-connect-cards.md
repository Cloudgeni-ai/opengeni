---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

When an agent asks for the same connection more than once, only the newest card stays a full card. Earlier copies from the same turn leave the timeline, Connected Machine requests included; copies from earlier turns are marked `AuthNeededItem.askedAgainLater`, which now applies to every connection card, and the stock chat and `AuthNeededRow` show them as one line. Cards with inputs are never folded.
