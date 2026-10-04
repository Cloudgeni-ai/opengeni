---
"@opengeni/config": minor
"@opengeni/core": patch
"@opengeni/runtime": patch
---

Stop offering features whose backend this deployment does not run. The new `OPENGENI_ARTIFACT_MATERIALIZER_DEPLOYED` setting (default `false`; Helm sets it from `artifactMaterializer.enabled`) removes `editable_artifact_export` and `editable_artifact_export_status` from the first-party tool ceiling when no materializer drains export jobs, and an explicit session request for them is dropped rather than rejected. The Gmail bridge offers `watch_mailbox` only when `OPENGENI_GMAIL_WATCH_TOPIC_NAME` is set.
