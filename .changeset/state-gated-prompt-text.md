---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A configured agent is sent `goal_resume` and its prompt sentence only once its session has a goal (in any state, so pausing or resuming never changes the tool list); the effective-tools projection follows the same rule. The "Images and video" guidance is left out when no image or video tool is attached, and the blocked-tool sentence mentions a setup card only when the agent has a capability that can show one.
