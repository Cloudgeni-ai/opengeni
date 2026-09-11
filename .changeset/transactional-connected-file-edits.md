---
"@opengeni/agent-proto": minor
"@opengeni/runtime": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Support capability-gated transactional large-file edits on Connected Machines,
with bounded transfers, verified outcomes, and live authorization checks. Keep
legacy agent writes compatible and report oversized outbound requests accurately
instead of marking a healthy agent offline. Native agent support is required;
unsupported filesystem semantics fail closed.