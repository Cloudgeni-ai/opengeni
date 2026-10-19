---
"@opengeni/agent-proto": minor
"@opengeni/runtime": minor
"@opengeni/db": minor
"@opengeni/core": minor
---

A finished command's stored output is now released on its runner in one answered exchange, for foreground and background commands alike. The agent serves a new `OpRelease` request (advertised as `capabilities.op_release`): it drops the operation at once and confirms the release in its answer, so the release settles right where the output is stored, while the agent is live from the command, and nothing about the command is left for a later maintenance pass. When the storing process dies first, the agent's own operation inventory recovers the release, so maintenance never sends such an agent anything to release output. Every request Opengeni sends on its own behalf carries `Opengeni-No-Wake`, which a compute host answers itself instead of waking a sleeping sandbox; an unanswered one records nothing and is left to the agent's next inventory. The agent remembers every operation it has started for longer than Opengeni may resend a start for it, independent of output retention and across an in-place update, so a released operation never runs again. Connected Machine agents without the capability keep the existing final acknowledgement and later observation; a compute sandbox whose agent lacks it is refused as an image built with an older agent.
