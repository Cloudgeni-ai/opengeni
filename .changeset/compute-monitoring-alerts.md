---
"@opengeni/deployment": patch
---

Compute now alerts on what its incidents look like. compute-control counts each host's fresh registrations (a host agent restarting) and its wake and placement refusals (a host full), and the chart adds OpenGeniCompute alerts for a host agent restarting, a host refusing wakes, a host unreachable, the fleet full with no spare memory, and failing sandbox creates. The spare memory threshold is `computeControl.alerts.spareMemoryMib` (default 4096). The compute-control ServiceMonitor moves to its own template, so a render of only the core workloads' monitoring (`--show-only templates/servicemonitor.yaml`) no longer includes it. The GCP compute Terraform module ships host journals to Cloud Logging through serial-port logging (`journal_to_cloud_logging`, default on).
