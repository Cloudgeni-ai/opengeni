---
"@opengeni/contracts": minor
"@opengeni/core": minor
---

A custom webhook's `eventId` can join 2 to 4 `parts`, each a path in the event or a header, with a `separator` (a dot by default). An alert's status, fingerprint and start time name one firing episode, so an app that resends a group of alerts runs each episode once, while a resolve or a later re-fire is a new event. An event missing a part has no id. Header parts are kept with the delivery, so a replay reads the same id.
