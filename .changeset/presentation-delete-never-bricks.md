---
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Deleting a slide no longer makes a presentation unopenable. The editor sent a bare `slide.delete` for slides that still had objects, which the kernel always rejects; the SDK saved that edit to the browser's local pending queue before validating it, so every later open replayed it and failed with `[ARTIFACT_PRESENTATION_BATCH_REJECTED] presentation scene is not empty`. Document and presentation edits are now checked against the current state before they are saved, a retained edit the kernel rejects is discarded on open so affected presentations open again, and slide deletion removes the slide's own objects first. The editor's two unlabelled trash buttons are replaced by one labelled Delete control with a tooltip that targets the selected object, or the current slide when nothing is selected, and asks for confirmation.
