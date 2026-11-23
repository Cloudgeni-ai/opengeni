---
"@opengeni/deployment": patch
---

Compute hosts report their swap slots (`compute.host.swap.total`, `compute.host.swap.free`), and the chart adds `OpenGeniComputeHostSwapSlotsLow`, which fires when a host has under 15 % of them free for five minutes. Every page zswap compresses takes a slot at its original size and guest memory compresses several times over, so a swap file smaller than the sandboxes' memory fills while zswap's pool is mostly empty; from then on nothing more is compressed and a host short of memory ends VMs. The agent now warns at start on swap smaller than the sandboxes' memory (it warned only under a quarter), host-setup makes a swap file left smaller than its current size anew at the next boot, and the compute dashboard shows free swap slots.
