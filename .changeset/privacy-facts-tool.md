---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/runtime": minor
"@opengeni/observability": minor
"@opengeni/react": minor
"@opengeni/worker-bundle": minor
---

Agents answer privacy, retention, training and "where does it run" questions from server facts. The new always-visible `privacy_facts` tool reports the chat's model, provider route and how it is paid for, the route's declared region, whether the workspace is EU-only, the provider's training, retention and processing location from one reviewed table with source links and the date checked, Opengeni's own retention facts, where the deployment hosts app data and where this chat's sandbox runs, and the deployment's privacy policy, subprocessor list, terms and support contact. New optional settings `OPENGENI_DATA_HOSTING_LOCATION` and `OPENGENI_LEGAL_SUBPROCESSORS_URL` declare the hosting and subprocessor list; unset, they are reported as unknown and the agent is pointed to the privacy policy. Unknowns are stated as unknown. The operational contract tells agents to call it for these questions and answer only from it.
