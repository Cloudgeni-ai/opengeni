---
"@opengeni/worker-bundle": patch
"@opengeni/documents": patch
---

Knowledge indexing stays idle when no document embedding credential is configured. Before, every queued Knowledge revision was claimed, failed before reaching the provider and retried on backoff forever, so the 15-second maintenance check always reported work and started a workflow each tick. Now the check reports no work and logs one warning, the indexing activity claims nothing, and queued revisions keep their place and index as soon as a credential is configured.
