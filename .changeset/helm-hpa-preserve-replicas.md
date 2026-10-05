---
---

Helm chart: Deployments owned by an HPA no longer reset to `replicaCount` on every `helm upgrade`, which killed the extra turn-worker pods and interrupted their in-flight turns.
