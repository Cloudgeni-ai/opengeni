---
"@opengeni/runtime": minor
"@opengeni/db": minor
---

Expose `getModalCommandStartInvocation`, `withModalCommandStartSignal`, and the `ModalCommandStartInvocation` type through `@opengeni/runtime/sandbox`, alongside the runtime-owned `ProviderCommandStartOutcomeUnknownError`.

Add the exported `SandboxSetupOutcomeUnknown` database type, an optional recovery-input flag, and optional details on the existing `admission-blocked` work result to park incomplete sandbox setup without replay.

In repository builds that apply the pinned Modal SDK patch, recover lost command-start acknowledgements through bounded, cancellable observation of the original invocation. Preserve uncertain setup commands as durable locators without replay or fabricated supervision, and keep failed-create cleanup fenced.

SDK adoption and cancellation depend on that repository patch. Vanilla npm `modal@0.9.0` does not acquire this behavior merely by installing `@opengeni/runtime`; the runtime's optional own-symbol integration does not require patch-only SDK error exports.
