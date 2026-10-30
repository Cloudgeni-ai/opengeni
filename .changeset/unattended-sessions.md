---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
---

Sessions can be created unattended. `unattended: true` on session create says no person will see or answer questions until the task ends, as in an API automation or another headless run. Until now the agent could not tell, so it ended such runs with a question nobody would read. An unattended session's instructions say a question ends the work unanswered: settle open choices with the most conventional option, finish the reversible work inside the workspace, never take or stand in for a step only a person can take, leave that and anything destructive, external or unauthorised undone, and end with the result, the assumptions made and the steps left for a person. Tools that wait for a person (`request_human_input`, `interaction_request_human`) are not offered. The setting is frozen at create under a reserved metadata key that caller metadata never sets, is not inherited by child sessions, a fork reads as attended, and a keyed retry that changes it conflicts. Interactive sessions are unchanged byte for byte.
