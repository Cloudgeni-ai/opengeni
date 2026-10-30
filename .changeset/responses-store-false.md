---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Main agent turns on Azure OpenAI and the OpenAI platform now send `store: false`, so the provider no longer keeps each response for 30 days. Compaction and single model calls on Azure are storeless too. Nothing read stored responses back: history is resent in full, provider item ids are stripped, and reasoning round-trips encrypted.
