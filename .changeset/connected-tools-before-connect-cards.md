---
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/runtime": patch
---

Connected tools that can do a task now win over a Connect card for an unconnected alternative. Tool search no longer shows an integration's Connect card by itself when the chat already has a connected account of the same kind (Outlook Mail beside an unconnected Gmail); the search result still names the integration, and the agent can show its card when the person asked for it. In the agent's integration catalog search, a service the person can already use in the chat comes before a same-category service they would still have to connect, unless the request names the unconnected service. The per-turn connector availability notice now says that a configured but unavailable connector is needed only when the person named it or no loaded tool can do the task.
