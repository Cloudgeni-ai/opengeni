---
"@opengeni/agent-proto": patch
"@opengeni/runtime": patch
---

Carry producer-selected relay owner routes through stream descriptors so multi-replica terminal and frame streams connect without ingress affinity. Relays authenticate and proxy directly to the channel owner, preserving its replay and epoch fences; scoped terminals refresh the route after owner loss without restarting the shell.
