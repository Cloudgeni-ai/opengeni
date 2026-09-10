---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

Remove the SDK Skill loader capability and use eager sandbox-free Skill reading
with a turn-prepared descriptor index. Keep on-demand checkout and repository
Skill discovery separate, and render Skill tool calls consistently in the timeline.