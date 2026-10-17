---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Each streamed model call now records how long it took: Opengeni's own work before dispatch, time to first token, time to first answer text and total duration, in milliseconds. The worker stores them on the call's usage event and its Insights fact (four nullable integer columns added without a table rewrite), so model speed and output tokens per second can be analysed per call later. Older calls and calls the worker did not stream stay unknown.
