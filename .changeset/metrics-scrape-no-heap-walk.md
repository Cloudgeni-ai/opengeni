---
"@opengeni/observability": patch
---

On Bun, the Prometheus scrape no longer collects the per-space `nodejs_heap_space_size_*` default metrics. Bun computes them from a full heap census that blocked the event loop for hundreds of milliseconds at every scrape, stalling every request in flight on API and worker processes. Heap totals remain available from `nodejs_heap_size_*` and `process_heap_bytes`.
