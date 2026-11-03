---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A configured agent now pays only for what it can use on every model call. Under `capabilities: "none"` it gets a neutral introduction unless it shares a workspace, and no tool search when nothing is deferred. A configured session that cannot install the tool router (lazy tool search off for the deployment) no longer gets the Tool discovery guidance. It gets `wait_for_input` and its waiting guidance only when something can resume it (compute, children, goals, schedules, a browser, media, or a person who can answer). It gets no Skill index when it has no Skills. `request_human_input` offers the secret question only with `secrets`, Skill reviews only with Skill management, and parent-agent guidance only in child sessions. Prompt sections about web search, learning, monitoring, design choices with workspace tools and goal audits appear only with their capability. Two new capabilities, `notifications` (notify, withdraw, inbox tidy and call) and `privacyFacts` (`privacy_facts` and its prompt rule), are on under `"all"` and off under `"none"` for a session create request. Sessions stored before keep the tools they had, and saved workspace defaults and schedules that start from `"none"` keep both. Sessions that have a feature get the same prompt as before; outside child sessions `request_human_input` no longer carries its parent-agent guidance. The model-context snapshot for the native Anthropic route now fills its instructions, layers and tools.
