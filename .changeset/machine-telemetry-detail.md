---
"@opengeni/react": minor
---

Add a per-machine telemetry detail view and upgrade the machine cards. The card now leads with a fused health verdict (connection + resource pressure + sample freshness), previews a CPU trend, and shows live freshness; opening a card reveals full metric history (CPU, memory, disk, load, GPU) over 15m/1h/6h/24h with threshold guides and a hover crosshair — rendering the downsampled series the API already served but nothing consumed. Resource meters now read as a coherent green/amber/red traffic-light aligned with the health verdict, and load average renders neutral (it is not core-normalized) with the run queue carrying the real saturation signal.
