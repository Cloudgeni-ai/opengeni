---
---

Helm chart: API and web rollouts no longer drop requests. Both surge a replacement pod before removing a serving one (`maxSurge: 1`, `maxUnavailable: 0`), and a terminating pod keeps serving in-flight requests for `preStopDrainSeconds` (default 10) after it leaves the Service endpoints, before SIGTERM. The hook uses the native `sleep` lifecycle action (Kubernetes 1.30+); set `preStopDrainSeconds: 0` to omit it.
