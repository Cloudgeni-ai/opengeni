---
"@opengeni/browserd": patch
---

Computer sessions on a Mac or Windows desktop now share one CUA worker instead of displacing each other. Two agents using the same machine used to restart the worker on every call, which threw away each other's observations and refs and failed actions with stale-target errors; now each keeps its own state and their calls take turns on the shared worker.
