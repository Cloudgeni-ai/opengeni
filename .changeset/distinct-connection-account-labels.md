---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/db": minor
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Several connections to the same tool server can now be told apart by people and agents. A connection has an optional `label`, a name its owner sets when connecting (`label` on create, an optional Name field in the key form and Connect's credential step) and changes or clears later (`PATCH .../connections/{id}` with `{ "label": … }`, or Rename on the connector page). Labels follow one rule everywhere: the provider's verified identity, else the person's name, else `<domain> account`; when two accounts with the same scope would still read the same, agents and account lists add when each was connected (then the time, then a short ID). A rename is display only: it changes neither the connection's version nor its authority, and reaches agents from the next turn.
