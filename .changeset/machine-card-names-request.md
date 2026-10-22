---
"@opengeni/react": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

When an agent is refused a personal (Only me) machine, the Connected Machine card now names the machine it asked for and leads with Allow; other machines and setup fold under "Use a different machine". The card event carries the requested machine as `requestedSandboxId`. If the agent asks again in a later turn, only the newest card stays a full card and earlier ones become one short line, so a chat no longer piles up copies of the same card.
