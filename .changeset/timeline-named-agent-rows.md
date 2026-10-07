---
"@opengeni/react": minor
---

Timeline rows for spawning an agent, messaging one, and every update one sends back now name the agent and link to its session. Agent updates inside a delivery pill render as named rows with a two-line preview and the full text on expand, and the pill says who sent them ("Update from API audit", "3 updates from API audit and Docs"). Repeated progress notes from one agent fold into its latest note. A child result still reads "Result from …", never "finished". `MessageTimeline` and `SessionConversation` accept `resolveSessionTitle` for current titles; without it, rows use the title given at spawn, then the generic labels.
