---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A configured agent now pays only for what it can use on every model call. Under `capabilities: "none"` it gets a neutral introduction unless it shares a workspace, and no tool search when nothing is deferred. It gets `wait_for_input` and its waiting guidance only when something can resume it (compute, children, goals, schedules, a browser, media, or a person who can answer). It gets no Skill index when it has no Skills. `request_human_input` offers the secret question only with `secrets`, Skill reviews only with Skill management, and parent-agent guidance only in child sessions. Prompt sections about web search, learning, monitoring, design choices with workspace tools and goal audits appear only with their capability. Two new capabilities, `notifications` (notify, withdraw, inbox tidy and call; follows `humanInput` for stored settings) and `privacyFacts` (`privacy_facts` and its prompt rule), are on under `"all"` and off under `"none"`. Sessions that have a feature render as before. The model-context snapshot for the native Anthropic route now fills its instructions, layers and tools.
