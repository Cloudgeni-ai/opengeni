---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

When an agent asks for the same connection more than once, only the newest card stays a full card. Earlier copies from the same turn leave the timeline; copies from earlier turns are marked `AuthNeededItem.askedAgainLater`, which now applies to every connection card, not only Connected Machine ones. Cards with inputs are never folded.
