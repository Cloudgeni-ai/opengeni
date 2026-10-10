---
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/worker-bundle": patch
---

Stop Modal boxes that only an unused browser or desktop keeps warm. After the general sandbox idle grace without use (agent tool calls, a person's input, or a visible live view's heartbeat), a saveable browser is checkpointed and suspended, other browsers and desktops are released as `idle_released`, and the box saves `/workspace` and stops. Saved browsers resume on demand, also when the desktop they were shown in has stopped.
