---
"@opengeni/worker-bundle": patch
---

Cancel and drain a pending display-title request when handing over to a Steer, rather than making the correction wait for the title. Preserve completed titles and usage, and restart title generation after a withdrawn Steer only when request custody permits it.
