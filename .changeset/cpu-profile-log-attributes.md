---
"@opengeni/observability": patch
---

The on-demand CPU profile log line now carries its summary (busy time, longest block, top functions and the longest block's stack). Before, the structured logger dropped those attributes, so only the report file inside the container had them.
