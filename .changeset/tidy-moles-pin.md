---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/runtime": minor
"@opengeni/sdk": minor
"@opengeni/worker-bundle": minor
---

Allow a digest-pinned capability-pack sandbox image to bind an immutable Modal image ID. OpenGeni now preserves the logical OCI digest on the lease, starts the provider-native image through `ModalImageSelector.fromId`, records the actual ID in the Modal session envelope, and clears lower-precedence IDs when a rig overrides the image.