---
"@opengeni/runtime": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/codemode": patch
---

An agent asked to use the person's own Chrome without naming a profile now opens a connected profile on the computer the agent's session runs on, when there is one, instead of the most recently active profile on any computer. The opened profile and the other connected profiles now say which computer each is on, and mark the one the session runs on, so an agent can tell when it landed on another machine and pick a different profile. Discovering attached Chrome profiles shows the same. The attached-browser list gives each bridge's `sandboxId` and `machineName`.
