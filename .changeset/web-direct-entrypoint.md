---
"opengeni-web": patch
---

The web image now starts its server directly as the container's main process instead of through a `bun run` wrapper. The wrapper crashed with a segmentation fault each time the container was stopped during a rollout, leaving a core dump on the host.
