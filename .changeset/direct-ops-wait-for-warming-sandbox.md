---
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A Browser, Computer, Terminal or Files request that arrives while a chat's sandbox is still starting now waits for that start, as a turn does, instead of failing with "sandbox lease is not attachable". A fresh chat's first Browser or Computer open no longer needs a retry. The API and the worker share one wait for a starting sandbox.
