---
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Prevent provider-native checkpoint capture from racing sandbox operations while
the provider has paused the source box. Capture now owns a durable
lease/epoch/instance/generation claim, blocks new holders and mutations, drains
provider-local reads before entering the exclusive snapshot call, and retains
ownership through late provider settlement and exact stale-claim recovery.
Modal's typed completed-exec stdin race is also normalized into a side-effect-free
terminal poll, so an exec that exits between local lookup and the provider write
settles its retained process instead of failing the enclosing turn.
