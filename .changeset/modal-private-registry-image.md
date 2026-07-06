---
"@opengeni/config": minor
"@opengeni/runtime": minor
"@opengeni/worker-bundle": minor
---

Support PRIVATE-registry Modal sandbox images via `OPENGENI_MODAL_IMAGE_REGISTRY_SECRET`.

The Agents-extension Modal backend resolves `OPENGENI_MODAL_IMAGE_REF` (and any pack
`sandboxImage` that overrides it) with `Image.fromRegistry(tag)` and no secret, so it could
only pull PUBLIC images. New optional setting `modalImageRegistrySecret` (env
`OPENGENI_MODAL_IMAGE_REGISTRY_SECRET`) names a Modal Secret holding `REGISTRY_USERNAME` +
`REGISTRY_PASSWORD`; when set, the runtime resolves that Secret and pre-builds
`fromRegistry(tag, secret)` ONCE per worker process (`ensureModalRegistryImage`, awaited in
`createOpenGeniWorker` boot) and the Modal provider selects it via
`ModalImageSelector.fromImage(...)`. When unset the behavior is byte-identical to today's
public-image path (and the modal SDK is never loaded for it). Resume/attach turns never pull
the image, so they are unaffected.
