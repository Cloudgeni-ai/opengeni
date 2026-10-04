---
"@opengeni/contracts": patch
"@opengeni/config": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Use canonical ComputerSession frames and actions for screen and window viewers. Preserve the painted frame fence, reflect authorized human input availability, and enforce human sandbox input policy on each action while retaining separate agent tool authority. Older controllers keep frame viewing behind an encrypted proxy without receiving RFB input grants.

App-only viewers require an explicit current input posture before enabling mutations. Refresh rechecks permission without starting a stream or native action, and physical machine screen-control consent remains separate from viewing.
