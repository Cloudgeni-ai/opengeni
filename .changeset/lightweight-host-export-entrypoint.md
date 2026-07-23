---
"@opengeni/worker-bundle": patch
---

Expose the durable host-export pump through a lightweight `@opengeni/worker-bundle/host-export` subpath so embedded API processes can project events and usage without loading Temporal's native worker runtime.
