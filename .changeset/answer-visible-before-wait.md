---
"@opengeni/react": patch
"@opengeni/runtime": patch
---

A person's question asked while the agent is working or waiting always gets a visible answer. `wait_for_input` is refused (as a tool error, at most twice per turn attempt; a resumed or retried attempt starts again, and the check fails open if it cannot decide) when the turn answers a person's message and the agent has not written any visible reply yet, so a status drafted only in reasoning is written out before the turn yields. `prepareAgentTools` accepts the new `inputWaitReplyGuard` option for this check.

In the timeline, a reply the agent wrote before more tool work and a wait stays visible after the "Worked for" row instead of folding into it: a turn that answers a person and ends with only progress notes keeps its first and last message visible, and the notes between them still fold.
