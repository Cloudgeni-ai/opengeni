---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/observability": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Show where recordings spend time between Stop and the transcript. The SDK measures storage uploads and finalize, React measures transcript delivery and composer insertion, and the API and worker emit recording stage timings with a shared recording key. Transcript long polling reports its intentional wait separately from active API work.
