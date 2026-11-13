---
"@opengeni/react": patch
---

A durable Send refused for good is now kept as the composer draft until it is removed, restored or delivered, so closing the page no longer loses it. It never overwrites a newer draft from another device. A kept send also survives the composer remounting in the same page. The composer no longer re-reads its draft on every host render while a delivered message waits for its turn: it now reads the latest `onSent`/`onSubmitted` through refs, and re-reads only when a new admission arrives.
