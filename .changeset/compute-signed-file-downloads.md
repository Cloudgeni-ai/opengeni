---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Attached files now arrive on sandbox backends that cannot mount object storage, such as the compute backend. Capability descriptors replace `nativeBucketMount: boolean` with `bucketMount: "native" | "in-container" | "none"`; a `"none"` backend always receives files as pre-signed downloads before the first model request, as Connected Machines already did.
