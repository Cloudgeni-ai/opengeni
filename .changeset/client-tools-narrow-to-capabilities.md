---
"@opengeni/core": patch
---

Session creation no longer refuses an API or SDK client whose `firstPartyMcpTools` names a tool of an agent capability that is off. The tool is left out instead, so a client built against an older capability map keeps working when a tool moves under a capability. An agent's own list is still checked strictly.
