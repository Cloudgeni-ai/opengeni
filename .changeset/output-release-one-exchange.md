---
"@opengeni/agent-proto": minor
"@opengeni/runtime": minor
"@opengeni/db": minor
"@opengeni/core": minor
---

A finished background command's stored output is now released on its runner in one answered exchange. The agent serves a new `OpRelease` request (advertised as `capabilities.op_release`): it drops the operation at once and confirms the release in its answer, so the release settles right where the output is stored, while the agent is live from the command, and nothing about the command is left for a later maintenance pass. The maintenance reaper only recovers a release whose storing process died first, and settles it from the same answer. Agents without the capability keep the existing final acknowledgement and later observation.
