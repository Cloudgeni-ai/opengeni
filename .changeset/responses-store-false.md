---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Main agent turns on Azure OpenAI and the OpenAI platform now send `store: false`, so the provider no longer keeps each response for 30 days. Compaction and single model calls on Azure are storeless too. Nothing read stored responses back: history is resent in full (WebSocket continuations chain only on the same connection), provider item ids are stripped, and reasoning round-trips encrypted. Operator registry providers, compatible servers and gateways are unchanged. The agent's `privacy_facts` tool now says Opengeni sends `store: false` on the routes that do, and that Opengeni does not turn storage off on the others.
