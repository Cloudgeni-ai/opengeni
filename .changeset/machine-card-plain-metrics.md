---
"@opengeni/react": patch
---

Machine cards on the Machines page show memory, disk and CPU, and no longer show the load average (1m, 5m, 15m) or run queue. Those numbers mean little to most people; the machine's detail panel still charts load over time, and `MachineMetrics` with `density="full"` still shows them.
