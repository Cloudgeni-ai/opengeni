---
"@opengeni/config": patch
---

Allow `OPENGENI_SANDBOX_IDLE_COMMAND_CONTAINMENT_MS=0` to explicitly disable new idle-command containment. Preserve the existing unset and positive-window behavior, provider-deadline containment, and already enrolled drains.